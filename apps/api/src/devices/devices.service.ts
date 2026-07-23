import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { Batch } from '../batches/batch.entity';
import { Asset, AssetStockStatus } from '../assets/asset.entity';
import { AssetAudit } from '../assets/asset-audit.entity';
import { AssetHistory, AssetEventType } from '../assets/asset-history.entity';
import { IngestAuditDto } from './dto/ingest-audit.dto';
import { HardwareProfile } from './hardware-profile.type';

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetAudit) private audits: Repository<AssetAudit>,
    @InjectRepository(AssetHistory) private history: Repository<AssetHistory>,
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
    const batches = await this.batches.find({ order: { batchNumber: 'ASC' } });
    return batches.map((b) => ({ id: b.id, batchNumber: b.batchNumber }));
  }

  // Collect a hardware audit INTO a lot. Deliberately no verification/matching
  // against a manifest and no "received" check — it simply creates the device in
  // the lot (or re-audits it if the same serial comes through again).
  //
  // The comprehensive `profile` is stored as-is (JSONB) on the asset and snapshotted
  // on the audit row. Only auto-derived hardware identity is written to the asset;
  // warehouse fields (grade, cost, location, status, notes) are never overwritten.
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

    const tag = serial || `HW-${Date.now()}`;
    const name = [manufacturer, model].filter(Boolean).join(' ').trim() || 'Audited device';
    const category = deviceType || 'Uncategorised';

    // Serial is the device identity; re-running just files another audit.
    let asset = await this.assets
      .createQueryBuilder('a')
      .where('LOWER(a.tag) = LOWER(:tag)', { tag })
      .getOne();
    let created = false;
    if (asset) {
      // Refresh only auto-captured hardware identity + profile; leave the lot as
      // set (moving it only if a different lot was chosen) and never touch grade,
      // cost, location, status or notes.
      await this.assets.update(asset.id, {
        name,
        category,
        manufacturer,
        model,
        deviceType,
        serialNumber: serial,
        expressServiceCode: expressCode,
        // cast: QueryDeepPartialEntity rejects the profile's open index signature.
        hardwareProfile: profile as any,
        ...(asset.batchId !== lotId ? { batchId: lotId } : {}),
        // Only touch the sub-lot when one was supplied (the USB tool never sends it).
        ...(dto.subLotId !== undefined ? { lotId: dto.subLotId } : {}),
      });
    } else {
      asset = await this.assets.save(
        this.assets.create({
          tag,
          name,
          category,
          manufacturer,
          model,
          deviceType,
          serialNumber: serial,
          expressServiceCode: expressCode,
          hardwareProfile: profile,
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
        hardwareProfile: profile,
        manufacturer,
        model,
        serialNumber: serial,
        cpu: profile?.cpu?.model ?? dto.cpu ?? null,
        ramGb: profile?.memory?.totalGb ?? dto.ramGb ?? null,
        storageCapacity:
          (firstDrive ? [firstDrive.capacity, firstDrive.type].filter(Boolean).join(' ') : '') ||
          dto.storageCapacity ||
          null,
        screenSize: profile?.display?.size ?? dto.screenSize ?? null,
        screenResolution: profile?.display?.resolution ?? dto.screenResolution ?? null,
        batteryHealth: profile?.battery?.health ?? dto.batteryHealth ?? null,
        biosLocked: dto.biosLocked ?? null,
        chargerIncluded: dto.chargerIncluded ?? null,
        dataWipeStatus: dto.dataWipeStatus ?? null,
        dataWipeMethod: dto.dataWipeMethod ?? null,
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
