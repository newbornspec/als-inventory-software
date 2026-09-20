import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User, UserRole } from '../users/user.entity';
import { PermissionsService } from '../auth/permissions.service';
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
import { downgradeDiscardClaim } from '../assets/wipe-method';
import {
  lockStatusOf,
  normaliseWipeDetail,
  wipeDetailNote,
} from './wipe-detail';
import { hostTag } from './host-identity';
import { expectedDrivesFromRows, rollupWipe } from './wipe-rollup';
import { CertificateLedger } from '../certificates/certificate-ledger';

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

// What a station wipe that named no lot says about itself (see lotlessWipe
// in ingest). Exported for the specs.
export const LOTLESS_WIPE_NOTE =
  'Wipe recorded without a lot: the station did not say which workflow or lot this machine belongs to - move the device into its lot.';
export const LOTLESS_WIPE_NOTE_HELD =
  'Wipe recorded without a lot: the station did not say which workflow or lot this machine belongs to. The device was left in the lot';

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetAudit) private audits: Repository<AssetAudit>,
    @InjectRepository(AssetHistory) private history: Repository<AssetHistory>,
    private activity: ActivityService,
    private permissions: PermissionsService,
    // Optional so the in-memory specs can leave it out; absent, or present
    // with signing off, it does nothing.
    @Optional() private ledger?: CertificateLedger,
  ) {}

  private readonly log = new Logger(DevicesService.name);

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
        .andWhere(`asset.stock_status != 'sold'`)
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
    // The station is a SHARED tool; the WORKFLOW decides the destination
    // (client correction, 2026-08-22). An 'amazon' audit is standalone — no
    // lot required, no lot touched, the record lives in the Audit workspace.
    // A 'goods_in' audit (and every legacy payload that names no kind) files
    // into a lot exactly as before. The route guard admits anyone holding
    // EITHER audit permission, so the kind named here is re-checked against
    // the caller's actual grants — a Goods In-only account cannot file Amazon
    // audits by editing the payload.
    const isAmazon = dto.auditKind === 'amazon';
    if (dto.auditKind) {
      const needed = isAmazon ? 'perform_amazon_audit' : 'perform_goods_in_audit';
      const authz = await this.permissions.getAuthz(userId);
      const allowed =
        authz && (authz.role === UserRole.ADMIN || authz.permissions.includes(needed));
      if (!allowed) {
        throw new ForbiddenException(
          `Your account is not permitted to record ${isAmazon ? 'Amazon' : 'Goods In'} audits.`,
        );
      }
    }

    // A stick still running the pre-19-Sep wipe engine can report a block
    // discard (TRIM) as "wiped". Kept as a record, filed as FAILED - it never
    // reaches the device as data_wiped and can never be certified. See
    // wipe-method.ts.
    dto = downgradeDiscardClaim(dto);

    const user = await this.users.findOne({ where: { id: userId } });
    // Amazon: any lotId in the payload is IGNORED, not honoured — once the
    // operator chose the workflow, nothing silently re-routes the audit.
    const lotId = isAmazon ? null : (dto.lotId ?? user?.activeAuditLotId ?? null);
    // A WIPE RECORD THAT NAMES NO LOT (incident, 2026-09-19). A station
    // account holding both audit permissions sends no auditKind until the
    // operator picks Amazon or Goods In - and the station let a drive be
    // erased before that. The drive was really sanitised, but this route
    // answered 400 "No audit lot selected", the stick treats every failure
    // as "queue and retry", and the record sat in the stick's queue forever
    // with nobody told. A wipe that physically happened must be on record,
    // and guessing a lot would re-attribute it to one it may not belong to.
    // So it is filed with NO lot - the same lotless shape an Amazon audit
    // already has - and says so on the record, for a person to move the
    // device into its lot. auditKind stays exactly as sent.
    //
    // Only a station wipe OUTCOME gets this. A capture (no dataWipeStatus)
    // keeps the 400: nothing irreversible happened, the operator picks a lot
    // and captures again. A manual add is a person at the web form, who can
    // pick a lot. A payload lotId or an active lot still wins, as before.
    const lotlessWipe =
      !isAmazon &&
      !lotId &&
      !dto.manual &&
      (dto.dataWipeStatus === DataWipeStatus.WIPED ||
        dto.dataWipeStatus === DataWipeStatus.FAILED);
    if (!isAmazon && !lotId && !lotlessWipe) {
      throw new BadRequestException(
        'No audit lot selected — pick the lot you are working on in Als Inventory first.',
      );
    }
    const batch = lotId ? await this.batches.findOne({ where: { id: lotId } }) : null;
    if (lotId && !batch) throw new NotFoundException(`Lot ${lotId} not found`);
    // From here on "files into a lot" means exactly the old non-Amazon path.
    const intoLot = !isAmazon && !lotlessWipe;

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

    // Serial, else the SMBIOS system UUID, else (no identity at all) a fresh
    // HW-<timestamp> asset as before. See host-identity.ts (owner decision D24).
    const tag = hostTag(serial, ident.biosUuid) ?? `HW-${Date.now()}`;
    const name = [manufacturer, model].filter(Boolean).join(' ').trim() || 'Audited device';
    const category = deviceType || 'Uncategorised';

    // The operator's explicit call if the tool sent one, else the floor the capture
    // itself establishes. Both land on the audit row unconditionally; what may reach
    // the asset is decided by derivedMayReplace.
    const auditStatus = dto.auditStatus ?? deriveAuditStatus(dto);

    // A wipe OUTCOME (one drive's record) never decides the asset's wipe status
    // on its own: the station files one record per drive, and "the latest
    // record wins" made a two-drive laptop read data_wiped whenever the good
    // drive's record happened to land last. The asset's wipe status is settled
    // after the row is saved, from EVERY drive's record, by settleWipeStatus
    // below. Until then this path writes at most the power-on floor the
    // capture proves - and an explicit data_wiped / data_wipe_failed in the
    // payload is a per-drive claim like any other, so it goes through the same
    // roll-up. Any other explicit call (a person's 'ready_for_sale') still wins
    // outright, as before.
    const wipeOutcome =
      !dto.manual &&
      (dto.dataWipeStatus === DataWipeStatus.WIPED ||
        dto.dataWipeStatus === DataWipeStatus.FAILED);
    const isWipeStatus = (s: AssetAuditStatus | null) =>
      s === AssetAuditStatus.DATA_WIPED ||
      s === AssetAuditStatus.DATA_WIPE_FAILED;
    const explicitStatus =
      dto.auditStatus && !(wipeOutcome && isWipeStatus(dto.auditStatus))
        ? dto.auditStatus
        : null;
    const floor = dto.profile ? AssetAuditStatus.POWER_ON : null;
    const assetStatus: AssetAuditStatus | null =
      explicitStatus ?? (wipeOutcome ? floor : deriveAuditStatus(dto));

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
        (assetStatus && derivedMayReplace(assetStatus, asset.auditStatus)
          ? assetStatus
          : null);
      // THE RE-AUDIT HAZARD, the API's half of it (contract C6). The hardware
      // functional test rides INSIDE the profile as profile.hardwareTest, and
      // this update replaces hardware_profile wholesale — so a machine tested
      // on Monday and re-audited on Wednesday (a fresh station boot, a later
      // wipe record, or just an updated grade) lost Monday's test from the
      // asset page, the Reports column and the report view. The station cannot
      // prevent it: its copy lives in that process's memory and cannot reach
      // across a reboot. The previous value only exists HERE, so this is the
      // only place it can be kept.
      //
      // One key, merged, no migration: when the arriving profile has no test
      // and the stored one does, the stored one stays. The asset was found by
      // tag, which IS this machine's identity (hostTag), so there is no
      // question of carrying a test onto different hardware. A profile that
      // brings its own test always wins — deliberately not "whichever is
      // newer", because the station's clock may be unset and says so itself
      // (clockWasNetwork), and a date that cannot be trusted is no basis for
      // choosing which result to keep.
      const storedTest = asset.hardwareProfile?.hardwareTest;
      const assetProfile =
        normalisedProfile && !normalisedProfile.hardwareTest && storedTest
          ? { ...normalisedProfile, hardwareTest: storedTest }
          : normalisedProfile;
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
        hardwareProfile: assetProfile as any,
        // Newest physical inspection wins, matching what the web audit form already
        // does (assets.service.ts createAudit). Guarded so a stick that sends no
        // grade leaves whatever the warehouse set.
        ...(dto.cosmeticGrade ? { conditionGrade: dto.cosmeticGrade } : {}),
        ...(statusPatch ? { auditStatus: statusPatch } : {}),
        // An Amazon audit never moves a device between lots — or out of one.
        // Only the Goods In workflow files devices into batches. A lotless
        // wipe (see lotlessWipe above) names no lot either, so it must not
        // take a device OUT of the lot it is already in.
        ...(intoLot && asset.batchId !== lotId ? { batchId: lotId } : {}),
        // Only touch the sub-lot when one was supplied (the USB tool never sends it).
        ...(intoLot && dto.subLotId !== undefined ? { lotId: dto.subLotId } : {}),
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
          ...(assetStatus ? { auditStatus: assetStatus } : {}),
          // Amazon-created devices carry NO lot: batch_id NULL is the spec's
          // own marker that the audit belongs to the workspace, not receiving.
          // A lotless wipe is created the same way (lotId is null there).
          batchId: lotId,
          lotId: intoLot ? (dto.subLotId ?? null) : null, // optional sub-lot (spec bucket)
          stockStatus: AssetStockStatus.AUDITED,
        }),
      );
      created = true;
    }

    // Derive the legacy audit-summary columns from the profile where present so
    // existing audit views keep working; the full detail lives in hardware_profile.
    const firstDrive = profile?.storage?.[0];

    // The per-drive wipe detail. Anything unusable is stored NULL and said in
    // the notes - never a 400, which the stick would retry forever. See
    // wipe-detail.ts.
    const { detail: wipeDetail, notes: detailNotes } = normaliseWipeDetail(dto);
    const detailNote = wipeDetailNote(detailNotes);
    // Said on the record itself (the asset page and the Audit workspace show
    // audit notes), and again on the history entry below.
    const lotlessNote = lotlessWipe
      ? await this.lotlessWipeNote(asset.batchId ?? null)
      : null;
    const notes =
      [dto.notes, detailNote, lotlessNote].filter(Boolean).join('\n') || null;
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
        // This route is the station's. 'station' means "filed through the
        // station's endpoint" - as trustworthy as that endpoint's callers,
        // which later steps of the remediation plan tighten (operator sign-in,
        // signed records). The web routes can never set this value.
        wipeSource: dto.dataWipeStatus ? 'station' : null,
        // Unconditional: asset_audits is the append-only compliance trail, so it
        // records the grade judged at this moment (or null). This is what the
        // erasure certificate's "Cosmetic grade" line reads.
        cosmeticGrade: dto.cosmeticGrade ?? null,
        // Unconditional for the same reason as cosmeticGrade above: this row is
        // the append-only trail, so it records what was judged at this moment,
        // including "not judged".
        screenGrade: dto.screenGrade ?? null,
        ...wipeDetail,
        // From the profile, not the payload, so old sticks get it too.
        lockStatus: lockStatusOf(normalisedProfile),
        notes,
        auditedById: userId,
      }),
    );

    if (wipeOutcome) {
      // Never fatal, for the same reason as issueCertificate: the wipe record
      // above is already committed, so a throw here (a DB error taking the
      // lock) became a 500 the stick retried - filing the same wipe again on
      // every retry, with the history and activity entries below skipped.
      // A missed settle leaves the asset's status one wipe behind until the
      // next wipe filed for it; the certificate routes and C4 decide from the
      // records themselves, never from this status, so no certificate can
      // come of it.
      try {
        await this.settleWipeStatus(asset.id);
      } catch (e) {
        this.log.error(
          `could not settle the wipe status of asset ${asset.id} after filing its wipe record (the next wipe filed for it will): ${(e as Error).message}`,
        );
      }
      await this.issueCertificate(asset.id);
    }

    await this.history.save(
      this.history.create({
        assetId: asset.id,
        eventType: AssetEventType.AUDITED,
        userId,
        notes: isAmazon
          ? 'Amazon audit captured'
          : lotlessWipe
            ? lotlessNote
            : dto.manual
              ? `Manually added to ${batch!.batchNumber}`
              : `Hardware audit captured into ${batch!.batchNumber}`,
      }),
    );

    await this.activity.record({
      userId,
      action: dto.manual ? 'asset.created' : 'audit.captured',
      entityType: 'asset',
      entityId: asset.id,
      summary: isAmazon
        ? `${created ? 'Audited new device' : 'Re-audited'} ${name} (Amazon audit)`
        : lotlessWipe
          ? `Recorded a wipe for ${name} without a lot`
          : dto.manual
            ? `Added ${name} to ${batch!.batchNumber}`
            : `${created ? 'Audited new device' : 'Re-audited'} ${name} into ${batch!.batchNumber}`,
    });

    return {
      created,
      assetId: asset.id,
      tag,
      name,
      deviceType,
      lot: batch?.batchNumber ?? null,
    };
  }

  // The note a lotless wipe carries (see lotlessWipe in ingest). A device the
  // server already knows may already sit in a lot: it is left there - the
  // wipe names no lot, so it is no reason to move the device anywhere - and
  // the note says which lot, for a person to confirm rather than "move it".
  private async lotlessWipeNote(heldLotId: string | null): Promise<string> {
    if (!heldLotId) return LOTLESS_WIPE_NOTE;
    const held = await this.batches.findOne({ where: { id: heldLotId } });
    return `${LOTLESS_WIPE_NOTE_HELD} ${held?.batchNumber ?? 'it was already in'} - check that is right.`;
  }

  // Plan step 29: with CERT_SIGNING_KEY set, the machine's signed certificate
  // is issued the moment it becomes certifiable - here, right after its wipe
  // status settles - so its issued date is the day it was erased, not the day
  // someone first downloaded it. In its OWN transaction, after the record is
  // committed, and never fatal: a failure here must not turn a filed wipe
  // into a 500 the stick retries forever (filing a duplicate row each time).
  // The first download issues it instead if this did not.
  private async issueCertificate(assetId: string): Promise<void> {
    if (!this.ledger?.enabled) return;
    try {
      await this.ledger.ensure(assetId);
    } catch (e) {
      this.log.error(
        `could not issue the signed certificate for asset ${assetId} at ingest (the first download will): ${(e as Error).message}`,
      );
    }
  }

  // The asset's wipe status, from every drive's record (plan step 23, owner
  // decision D23): data_wiped only when rollupWipe says the MACHINE is wiped -
  // every drive's latest record a wipe, and every internal drive of the
  // wipe-time profile accounted for - otherwise data_wipe_failed, which also
  // covers "still wiping" (no enum change). Still through derivedMayReplace,
  // so a person's 'ready_for_sale' is never overwritten by a machine.
  //
  // WHY THE LOCK. A multi-drive laptop's records arrive as separate requests,
  // often seconds apart (the station wipes drives in parallel), and can be
  // handled by two API instances at once. Without a lock, request A (drive A
  // wiped) can read the rows before request B's FAILED row exists, B then
  // writes data_wipe_failed, and A - finishing last - overwrites it with
  // data_wiped. Each request saves its own row FIRST (committed), then takes
  // the asset row FOR UPDATE and reads the rows inside that lock, so whichever
  // request settles last is guaranteed to see both rows, and its answer is
  // the one that stays.
  //
  // OLD STICKS. Records that name no drive are decided by the interim D11
  // rule (certificate-eligibility.ts) here too, not only for the
  // certificate: "latest wins" is exactly what read a two-drive laptop as
  // data_wiped when its second drive had failed a minute earlier. Deliberate
  // and owner-reversible; the cost is that a machine failed and then re-wiped
  // within 24 hours on an old stick shows data_wipe_failed - and so sits in
  // Quarantine - with its certificate refused, until a wipe is filed at
  // least 24 hours after the failure. The window is measured between the
  // records, not against the current time, and this only runs when a wipe
  // is filed: time passing clears nothing, and neither does a re-capture
  // (pinned in wipe-settle.spec.ts). Before wave 2 such a machine read
  // data_wiped (latest wins) and only its certificate was refused.
  private async settleWipeStatus(assetId: string): Promise<void> {
    await this.assets.manager.transaction(async (m) => {
      const current = await m
        .getRepository(Asset)
        .createQueryBuilder('a')
        .setLock('pessimistic_write')
        .where('a.id = :id', { id: assetId })
        .getOne();
      if (!current) return;
      const rows = await m.getRepository(AssetAudit).find({
        where: {
          assetId,
          dataWipeStatus: In([DataWipeStatus.WIPED, DataWipeStatus.FAILED]),
        },
      });
      const { verdict } = rollupWipe(rows, expectedDrivesFromRows(rows));
      if (verdict === 'none') return;
      const next =
        verdict === 'wiped'
          ? AssetAuditStatus.DATA_WIPED
          : AssetAuditStatus.DATA_WIPE_FAILED;
      if (derivedMayReplace(next, current.auditStatus)) {
        await m.getRepository(Asset).update(assetId, { auditStatus: next });
      }
    });
  }
}
