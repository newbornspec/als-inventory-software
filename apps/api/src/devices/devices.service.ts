import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { Batch } from '../batches/batch.entity';
import { Asset, AssetStockStatus } from '../assets/asset.entity';
import { AssetAudit } from '../assets/asset-audit.entity';
import { AssetHistory, AssetEventType } from '../assets/asset-history.entity';
import { IngestAuditDto } from './dto/ingest-audit.dto';

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

  // Collect a hardware audit INTO a lot. Deliberately no verification/matching
  // against a manifest and no "received" check — it simply creates the device in
  // the lot (or re-audits it if the same serial comes through again).
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

    const tag = (dto.serialNumber && dto.serialNumber.trim()) || `HW-${Date.now()}`;
    const name = [dto.manufacturer, dto.model].filter(Boolean).join(' ').trim() || 'Audited device';

    // Serial is the device identity; re-running just files another audit.
    let asset = await this.assets
      .createQueryBuilder('a')
      .where('LOWER(a.tag) = LOWER(:tag)', { tag })
      .getOne();
    let created = false;
    if (asset) {
      if (asset.batchId !== lotId) await this.assets.update(asset.id, { batchId: lotId });
    } else {
      asset = await this.assets.save(
        this.assets.create({
          tag,
          name,
          category: dto.category?.trim() || 'Uncategorised',
          batchId: lotId,
          stockStatus: AssetStockStatus.AUDITED,
        }),
      );
      created = true;
    }

    await this.audits.save(
      this.audits.create({
        assetId: asset.id,
        manufacturer: dto.manufacturer ?? null,
        model: dto.model ?? null,
        serialNumber: dto.serialNumber ?? null,
        cpu: dto.cpu ?? null,
        ramGb: dto.ramGb ?? null,
        storageCapacity: dto.storageCapacity ?? null,
        screenSize: dto.screenSize ?? null,
        screenResolution: dto.screenResolution ?? null,
        batteryHealth: dto.batteryHealth ?? null,
        biosLocked: dto.biosLocked ?? null,
        chargerIncluded: dto.chargerIncluded ?? null,
        notes: dto.notes ?? null,
        auditedById: userId,
      }),
    );

    await this.history.save(
      this.history.create({
        assetId: asset.id,
        eventType: AssetEventType.AUDITED,
        userId,
        notes: `Hardware audit captured into ${batch.batchNumber}`,
      }),
    );

    return { created, assetId: asset.id, tag: asset.tag, name: asset.name, lot: batch.batchNumber };
  }
}
