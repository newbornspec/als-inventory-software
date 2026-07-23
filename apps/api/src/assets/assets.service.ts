import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from './asset.entity';
import { AssetEventType, AssetHistory } from './asset-history.entity';
import { AssetAudit } from './asset-audit.entity';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import { CreateAssetAuditDto } from './dto/create-asset-audit.dto';
import { sanitizeUser } from '../users/sanitize-user';
import { ActivityService } from '../activity/activity.service';
import { isScopedManager, type RequestUser } from '../common/ownership';

@Injectable()
export class AssetsService {
  constructor(
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetHistory) private history: Repository<AssetHistory>,
    @InjectRepository(AssetAudit) private audits: Repository<AssetAudit>,
    private activity: ActivityService,
  ) {}

  async findAll(query: QueryAssetsDto, user?: RequestUser): Promise<Asset[]> {
    const qb = this.assets
      .createQueryBuilder('asset')
      .leftJoinAndSelect('asset.location', 'location')
      .orderBy('asset.updatedAt', 'DESC');

    // Managers see only assets whose batch they own; the inner join drops
    // unbatched/others' assets. Admins/technicians (and internal calls) see all.
    if (isScopedManager(user)) {
      qb.innerJoin('asset.batch', 'ownerBatch').andWhere('ownerBatch.ownerId = :ownerUid', {
        ownerUid: user!.userId,
      });
    }

    if (query.search) {
      qb.andWhere(
        '(asset.tag ILIKE :search OR asset.name ILIKE :search OR asset.serialNumber ILIKE :search OR asset.expressServiceCode ILIKE :search)',
        { search: `%${query.search}%` },
      );
    }
    if (query.category) {
      qb.andWhere('asset.category = :category', { category: query.category });
    }
    if (query.stockStatus) {
      qb.andWhere('asset.stockStatus = :stockStatus', { stockStatus: query.stockStatus });
    }
    if (query.conditionGrade) {
      qb.andWhere('asset.conditionGrade = :conditionGrade', {
        conditionGrade: query.conditionGrade,
      });
    }
    if (query.auditStatus) {
      qb.andWhere('asset.auditStatus = :auditStatus', { auditStatus: query.auditStatus });
    }
    if (query.locationId) {
      qb.andWhere('asset.locationId = :locationId', { locationId: query.locationId });
    }
    if (query.batchId) {
      qb.andWhere('asset.batchId = :batchId', { batchId: query.batchId });
    }
    if (query.noBatch === 'true') {
      qb.andWhere('asset.batchId IS NULL');
    }
    if (query.lotId) {
      qb.andWhere('asset.lotId = :lotId', { lotId: query.lotId });
    }

    return qb.getMany();
  }

  async findOne(id: string, user?: RequestUser): Promise<Asset> {
    // hardwareProfile is select:false (kept out of list views), so add it back
    // explicitly here where the full device detail is wanted.
    const qb = this.assets
      .createQueryBuilder('asset')
      .leftJoinAndSelect('asset.location', 'location')
      .leftJoinAndSelect('asset.owner', 'owner')
      .addSelect('asset.hardwareProfile')
      .where('asset.id = :id', { id });
    // For a scoped manager, an asset outside their batches is treated as
    // not-found (don't reveal it exists). Admins/technicians/internal: no filter.
    if (isScopedManager(user)) {
      qb.innerJoin('asset.batch', 'ownerBatch').andWhere('ownerBatch.ownerId = :ownerUid', {
        ownerUid: user!.userId,
      });
    }
    const asset = await qb.getOne();
    if (!asset) throw new NotFoundException(`Asset ${id} not found`);
    // owner is a User relation — never return it with passwordHash intact.
    if (asset.owner) asset.owner = sanitizeUser(asset.owner) as Asset['owner'];
    return asset;
  }

  async findHistory(assetId: string, user?: RequestUser): Promise<AssetHistory[]> {
    await this.findOne(assetId, user); // 404s if the asset doesn't exist or isn't visible
    return this.history.find({
      where: { assetId },
      order: { createdAt: 'DESC' },
    });
  }

  async findAudits(assetId: string, user?: RequestUser): Promise<AssetAudit[]> {
    await this.findOne(assetId, user);
    return this.audits.find({
      where: { assetId },
      order: { createdAt: 'DESC' },
    });
  }

  async create(dto: CreateAssetDto, userId: string): Promise<Asset> {
    const asset = await this.assets.save(this.assets.create(dto));
    await this.logEvent(asset.id, AssetEventType.CREATED, userId, 'Asset created');
    await this.activity.record({
      userId,
      action: 'asset.created',
      entityType: 'asset',
      entityId: asset.id,
      summary: `Created ${asset.name}`,
    });
    return asset;
  }

  async update(id: string, dto: UpdateAssetDto, userId: string): Promise<Asset> {
    const before = await this.findOne(id);

    await this.assets.update(id, dto);
    const after = await this.findOne(id);

    if (dto.stockStatus && dto.stockStatus !== before.stockStatus) {
      await this.logEvent(
        id,
        AssetEventType.STATUS_CHANGED,
        userId,
        `${before.stockStatus} -> ${after.stockStatus}`,
      );
    }
    if (dto.conditionGrade && dto.conditionGrade !== before.conditionGrade) {
      await this.logEvent(
        id,
        AssetEventType.CONDITION_CHANGED,
        userId,
        `${before.conditionGrade ?? 'ungraded'} -> ${after.conditionGrade}`,
      );
    }
    if (dto.locationId && dto.locationId !== before.locationId) {
      await this.logEvent(
        id,
        AssetEventType.TRANSFERRED,
        userId,
        `location ${before.locationId ?? 'none'} -> ${after.locationId}`,
      );
    }

    // High-level feed entry. If the batch changed, call it a move; else an edit.
    const moved = dto.batchId !== undefined && dto.batchId !== before.batchId;
    await this.activity.record({
      userId,
      action: moved ? 'asset.moved' : 'asset.updated',
      entityType: 'asset',
      entityId: id,
      summary: moved ? `Moved ${after.name} to another lot` : `Edited ${after.name}`,
    });

    return after;
  }

  // Records a full ITAD audit event and denormalizes its condition/audit
  // outcome onto the asset itself, so list views can filter by "latest
  // grade" without joining the full audit history every time.
  async createAudit(assetId: string, dto: CreateAssetAuditDto, userId: string): Promise<AssetAudit> {
    await this.findOne(assetId); // 404s if the asset doesn't exist

    const audit = await this.audits.save(
      this.audits.create({ ...dto, assetId, auditedById: userId }),
    );

    await this.assets.update(assetId, {
      ...(dto.cosmeticGrade ? { conditionGrade: dto.cosmeticGrade } : {}),
      ...(dto.auditStatus ? { auditStatus: dto.auditStatus } : {}),
    });

    await this.logEvent(
      assetId,
      AssetEventType.AUDITED,
      userId,
      dto.finalDisposition ? `Audit recorded — disposition: ${dto.finalDisposition}` : 'Audit recorded',
    );

    return audit;
  }

  async remove(id: string, userId?: string): Promise<void> {
    const before = await this.findOne(id); // 404s if the asset doesn't exist
    await this.assets.delete(id);
    await this.activity.record({
      userId,
      action: 'asset.deleted',
      entityType: 'asset',
      entityId: id,
      summary: `Deleted ${before.name}`,
    });
  }

  private async logEvent(
    assetId: string,
    eventType: AssetEventType,
    userId: string,
    notes: string,
  ): Promise<void> {
    await this.history.save(this.history.create({ assetId, eventType, userId, notes }));
  }
}
