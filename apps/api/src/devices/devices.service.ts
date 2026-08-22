import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { Batch } from '../batches/batch.entity';
import { Asset, AssetAuditStatus, AssetStockStatus } from '../assets/asset.entity';
import { nextUnitId } from '../assets/unit-id';
import { AssetAudit, DataWipeStatus } from '../assets/asset-audit.entity';
import { AssetHistory, AssetEventType } from '../assets/asset-history.entity';
import { IngestAuditDto } from './dto/ingest-audit.dto';
import { HardwareProfile } from './hardware-profile.type';
import { normaliseHardwareProfile } from './normalise-profile';
import { screenSizeFor, standardiseRamGb } from '../common/spec-normalise';
import { ActivityService } from '../activity/activity.service';

// What a capture proves on its own, for the normal case where the tool sends no
// explicit call. Deliberately the floor rather than a guess: nothing here claims a
// unit passed testing, only what the capture demonstrably establishes.
export function deriveAuditStatus(dto: IngestAuditDto): AssetAuditStatus | null {
  // Hand-entered devices are typed off a label, not tested. The web form still
  // builds a `profile` out of what was typed, so without this check that profile
  // would read below as evidence the machine booted.
  if (dto.manual) return null;
  if (dto.dataWipeStatus === DataWipeStatus.WIPED) return AssetAuditStatus.DATA_WIPED;
  if (dto.dataWipeStatus === DataWipeStatus.FAILED) return AssetAuditStatus.DATA_WIPE_FAILED;
  // The capture tool boots on the machine itself, so a profile coming back from it
  // is proof the unit powers on and POSTs.
  if (dto.profile) return AssetAuditStatus.POWER_ON;
  return null;
}

// The only three outcomes deriveAuditStatus can produce. A wipe result outranks the
// bare power-on floor; the two wipe results are peers, because which one is true is a
// question of which happened most recently, not which is stronger.
const DERIVED_RANK: Partial<Record<AssetAuditStatus, number>> = {
  [AssetAuditStatus.POWER_ON]: 1,
  [AssetAuditStatus.DATA_WIPE_FAILED]: 2,
  [AssetAuditStatus.DATA_WIPED]: 2,
};

// May a value this path DERIVED replace what the asset already carries?
//
// The rule this replaces was "only ever fill a blank", which quietly lost real
// outcomes: a unit sitting at 'power_on' (from an earlier capture, or from the
// backfill migration) could be securely erased and the asset would still read
// 'power_on' forever, contradicting the precedence deriveAuditStatus and the backfill
// both assert. Ranking fixes that without reopening the downgrade hole:
//
//   - anything not in DERIVED_RANK is a human's call ('ready_for_sale',
//     'passed_testing', …) and is never overwritten by a machine's inference;
//   - a plain re-capture can never erase a wipe result (rank 1 cannot replace rank 2);
//   - a wipe result replaces the power-on floor, and either wipe result replaces the
//     other, so a re-wipe that finally succeeds is recorded — the >= is deliberate,
//     a strict > would strand a unit on 'data_wipe_failed' permanently;
//   - an unchanged value is not rewritten: assets is in the powersync publication, so
//     a no-op UPDATE still costs a WAL record and a sync to every offline client.
export function derivedMayReplace(
  next: AssetAuditStatus,
  current: AssetAuditStatus | null,
): boolean {
  if (current == null) return true;
  if (next === current) return false;
  const currentRank = DERIVED_RANK[current];
  const nextRank = DERIVED_RANK[next];
  if (currentRank == null || nextRank == null) return false;
  return nextRank >= currentRank;
}

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetAudit) private audits: Repository<AssetAudit>,
    @InjectRepository(AssetHistory) private history: Repository<AssetHistory>,
    private activity: ActivityService,
  ) {}

  async setActiveLot(userId: string, batchId: string) {
    const batch = await this.batches.findOne({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(`Lot ${batchId} not found`);
    await this.users.update(userId, { activeAuditLotId: batchId });
    return { batchId: batch.id, batchNumber: batch.batchNumber };
  }

  async getActiveLot(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user?.activeAuditLotId) return null;
    const batch = await this.batches.findOne({ where: { id: user.activeAuditLotId } });
    if (!batch) return null;
    return { batchId: batch.id, batchNumber: batch.batchNumber };
  }

  // Compact lot list for the capture tool's on-device lot picker — id + number
  // only, so the bash script can parse it without a JSON library.
  async listLots() {
    const batches = await this.batches.find({
      order: { batchNumber: 'ASC' },
      relations: { createdBy: true },
    });
    // Live count of assets per batch (matches the web app's "actual units"):
    // sold assets keep their batch link for provenance but are out of stock.
    const counts = new Map<string, number>();
    if (batches.length) {
      const rows = await this.assets
        .createQueryBuilder('asset')
        .select('asset.batchId', 'batchId')
        .addSelect('COUNT(*)', 'total')
        .where('asset.batchId IN (:...ids)', { ids: batches.map((b) => b.id) })
        .andWhere(`asset.stock_status != 'sold' AND asset.pallet_id IS NULL`)
        .groupBy('asset.batchId')
        .getRawMany<{ batchId: string; total: string }>();
      for (const r of rows) counts.set(r.batchId, parseInt(r.total, 10));
    }
    return batches.map((b) => ({
      id: b.id,
      batchNumber: b.batchNumber,
      createdAt: b.createdAt,
      createdByName: b.createdBy?.name ?? null,
      actualUnitCount: counts.get(b.id) ?? 0,
      expectedUnitCount: b.expectedUnitCount,
    }));
  }

  // Collect a hardware audit INTO a lot. Deliberately no verification/matching
  // against a manifest and no "received" check — it simply creates the device in
  // the lot (or re-audits it if the same serial comes through again).
  //
  // The comprehensive `profile` is stored as-is (JSONB) on the asset and snapshotted
  // on the audit row. Auto-derived hardware identity plus the operator's chosen
  // grade and audit outcome are written to the asset; the remaining warehouse fields
  // (cost, location, stock status, notes) are never overwritten. The grade is written
  // ONLY when the capture tool actually sends one, so an older USB stick can never
  // blank a grade set in the web app. The audit outcome is guarded more precisely, by
  // rank rather than by "fill blanks only" — see deriveAuditStatus and derivedMayReplace.
  async ingest(userId: string, dto: IngestAuditDto) {
    const user = await this.users.findOne({ where: { id: userId } });
    const lotId = dto.lotId ?? user?.activeAuditLotId ?? null;
    if (!lotId) {
      throw new BadRequestException(
        'No audit lot selected — pick the lot you are working on in Als Inventory first.',
      );
    }
    const batch = await this.batches.findOne({ where: { id: lotId } });
    if (!batch) throw new NotFoundException(`Lot ${lotId} not found`);

    // Prefer the rich profile; fall back to the legacy flat fields.
    const profile: HardwareProfile | null = dto.profile ?? null;
    const ident = profile?.identification ?? {};

    const manufacturer = ident.manufacturer ?? dto.manufacturer ?? null;
    const model = ident.model ?? dto.model ?? null;
    const serial = (ident.serialNumber ?? dto.serialNumber ?? '').trim() || null;
    const deviceType = (ident.deviceType ?? dto.category ?? '').trim() || null;
    const expressCode = ident.expressServiceCode?.trim() || null;

    // Normalise the captured spec once, here. Both the USB tool and the manual
    // add-asset form land on this path, and the label, the xlsx export and the
    // web app all read what this writes — so standardising on the way in is what
    // keeps them from disagreeing. See common/spec-normalise.ts for the rules.
    const normalisedProfile = normaliseHardwareProfile(profile, deviceType);
    const ramGb = standardiseRamGb(profile?.memory?.totalGb ?? dto.ramGb ?? null);
    const screenSize = screenSizeFor(deviceType, profile?.display?.size ?? dto.screenSize ?? null);

    const tag = serial || `HW-${Date.now()}`;
    const name = [manufacturer, model].filter(Boolean).join(' ').trim() || 'Audited device';
    const category = deviceType || 'Uncategorised';

    // The operator's explicit call if the tool sent one, else the floor the capture
    // itself establishes. Both land on the audit row unconditionally; what may reach
    // the asset is decided by derivedMayReplace.
    const explicitStatus = dto.auditStatus ?? null;
    const auditStatus = explicitStatus ?? deriveAuditStatus(dto);

    // Serial is the device identity; re-running just files another audit.
    let asset = await this.assets
      .createQueryBuilder('a')
      .where('LOWER(a.tag) = LOWER(:tag)', { tag })
      .getOne();
    let created = false;
    if (asset) {
      // An explicit call always wins. A derived one has to outrank what is already
      // there, so a routine re-capture can never downgrade a technician's
      // 'ready_for_sale' to 'power_on' — but a wipe result still lands on a unit
      // previously known only to power on. See derivedMayReplace.
      const statusPatch =
        explicitStatus ??
        (auditStatus && derivedMayReplace(auditStatus, asset.auditStatus) ? auditStatus : null);
      // Refresh auto-captured hardware identity + profile, and the grade when the
      // operator supplied one; leave the lot as set (moving it only if a different
      // lot was chosen) and never touch cost, location, stock status or notes.
      await this.assets.update(asset.id, {
        name,
        category,
        manufacturer,
        model,
        deviceType,
        serialNumber: serial,
        expressServiceCode: expressCode,
        // cast: QueryDeepPartialEntity rejects the profile's open index signature.
        hardwareProfile: normalisedProfile as any,
        // Newest physical inspection wins, matching what the web audit form already
        // does (assets.service.ts createAudit). Guarded so a stick that sends no
        // grade leaves whatever the warehouse set.
        ...(dto.cosmeticGrade ? { conditionGrade: dto.cosmeticGrade } : {}),
        ...(statusPatch ? { auditStatus: statusPatch } : {}),
        ...(asset.batchId !== lotId ? { batchId: lotId } : {}),
        // Only touch the sub-lot when one was supplied (the USB tool never sends it).
        ...(dto.subLotId !== undefined ? { lotId: dto.subLotId } : {}),
      });
    } else {
      asset = await this.assets.save(
        this.assets.create({
          tag,
          unitId: await nextUnitId(this.assets),
          name,
          category,
          manufacturer,
          model,
          deviceType,
          serialNumber: serial,
          expressServiceCode: expressCode,
          hardwareProfile: normalisedProfile,
          ...(dto.cosmeticGrade ? { conditionGrade: dto.cosmeticGrade } : {}),
          // No existing value to protect on a brand-new asset, so the derived
          // floor applies unguarded.
          ...(auditStatus ? { auditStatus } : {}),
          batchId: lotId,
          lotId: dto.subLotId ?? null, // optional sub-lot (spec bucket)
          stockStatus: AssetStockStatus.AUDITED,
        }),
      );
      created = true;
    }

    // Derive the legacy audit-summary columns from the profile where present so
    // existing audit views keep working; the full detail lives in hardware_profile.
    const firstDrive = profile?.storage?.[0];
    await this.audits.save(
      this.audits.create({
        assetId: asset.id,
        // Unconditional, like cosmeticGrade below: this is the append-only trail,
        // so it records what this event established — including a derived floor
        // the asset itself may have declined to take, and null when the capture
        // proves nothing at all.
        auditStatus,
        // Phase-5 provenance, straight onto the trail. NULL from old sticks.
        auditKind: dto.auditKind ?? null,
        operatorName: dto.operatorName ?? null,
        restoreImageStatus: dto.restoreImageStatus ?? null,
        restoreImageName: dto.restoreImageName ?? null,
        hardwareProfile: normalisedProfile,
        manufacturer,
        model,
        serialNumber: serial,
        cpu: profile?.cpu?.model ?? dto.cpu ?? null,
        ramGb,
        storageCapacity:
          (firstDrive ? [firstDrive.capacity, firstDrive.type].filter(Boolean).join(' ') : '') ||
          dto.storageCapacity ||
          null,
        screenSize,
        screenResolution: profile?.display?.resolution ?? dto.screenResolution ?? null,
        batteryHealth: profile?.battery?.health ?? dto.batteryHealth ?? null,
        biosLocked: dto.biosLocked ?? null,
        chargerIncluded: dto.chargerIncluded ?? null,
        dataWipeStatus: dto.dataWipeStatus ?? null,
        dataWipeMethod: dto.dataWipeMethod ?? null,
        // Unconditional: asset_audits is the append-only compliance trail, so it
        // records the grade judged at this moment (or null). This is what the
        // erasure certificate's "Cosmetic grade" line reads.
        cosmeticGrade: dto.cosmeticGrade ?? null,
        notes: dto.notes ?? null,
        auditedById: userId,
      }),
    );

    await this.history.save(
      this.history.create({
        assetId: asset.id,
        eventType: AssetEventType.AUDITED,
        userId,
        notes: dto.manual
          ? `Manually added to ${batch.batchNumber}`
          : `Hardware audit captured into ${batch.batchNumber}`,
      }),
    );

    await this.activity.record({
      userId,
      action: dto.manual ? 'asset.created' : 'audit.captured',
      entityType: 'asset',
      entityId: asset.id,
      summary: dto.manual
        ? `Added ${name} to ${batch.batchNumber}`
        : `${created ? 'Audited new device' : 'Re-audited'} ${name} into ${batch.batchNumber}`,
    });

    return {
      created,
      assetId: asset.id,
      tag,
      name,
      deviceType,
      lot: batch.batchNumber,
    };
  }
}
