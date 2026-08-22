import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset, AssetStockStatus } from './asset.entity';
import { nextUnitId } from './unit-id';
import { Batch, BatchStatus } from '../batches/batch.entity';
import { AssetEventType, AssetHistory } from './asset-history.entity';
import { AssetAudit } from './asset-audit.entity';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import { CreateAssetAuditDto } from './dto/create-asset-audit.dto';
import { sanitizeUser } from '../users/sanitize-user';
import { screenSizeFor, standardiseRamGb } from '../common/spec-normalise';
import { ActivityService } from '../activity/activity.service';
import {
  isScopedManager,
  managerBatchCondition,
  managerCanAccessBatch,
  type RequestUser,
} from '../common/ownership';

@Injectable()
export class AssetsService {
  constructor(
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetHistory) private history: Repository<AssetHistory>,
    @InjectRepository(AssetAudit) private audits: Repository<AssetAudit>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
    private activity: ActivityService,
  ) {}

  // A scoped manager may only place/keep an asset in a lot they can access
  // (their own, or an unowned pool lot).
  private async assertOwnsTargetLot(batchId: string | null | undefined, user?: RequestUser) {
    if (!isScopedManager(user)) return;
    if (!(await managerCanAccessBatch(this.batches, batchId, user!))) {
      throw new ForbiddenException('You do not own that lot.');
    }
  }

  async findAll(query: QueryAssetsDto, user?: RequestUser): Promise<Asset[]> {
    const qb = this.assets
      .createQueryBuilder('asset')
      .leftJoinAndSelect('asset.location', 'location')
      .orderBy('asset.updatedAt', 'DESC');

    // Managers see only assets whose batch they own; the inner join drops
    // unbatched/others' assets. Admins/technicians (and internal calls) see all.
    if (isScopedManager(user)) {
      qb.innerJoin('asset.batch', 'ownerBatch').andWhere(managerBatchCondition('ownerBatch'), {
        ownerUid: user!.userId,
      });
    }

    // Palletised devices stay in lists (the register keeps them) — join the
    // pallet so rows can show and link the allocation.
    qb.leftJoinAndSelect('asset.pallet', 'pallet');
    // Sold assets are out of active inventory: excluded from every list/search
    // unless the caller explicitly filters by a status (e.g. the Sold archive
    // asking for stockStatus=sold).
    if (!query.stockStatus) {
      qb.andWhere('asset.stockStatus != :soldStatus', { soldStatus: AssetStockStatus.SOLD });
    }

    if (query.search) {
      qb.andWhere(
        '(asset.tag ILIKE :search OR asset.unitId ILIKE :search OR asset.name ILIKE :search OR asset.serialNumber ILIKE :search OR asset.expressServiceCode ILIKE :search)',
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
    if (query.noLocation === 'true') {
      qb.andWhere('asset.locationId IS NULL');
    }
    if (query.noAudit === 'true') {
      qb.andWhere('asset.auditStatus IS NULL');
    }
    // Palletised devices STAY in the register (labels must keep scanning to a
    // hit) -- this filter is how the Goods In pool excludes them instead.
    if (query.onPallet === 'true') {
      qb.andWhere('asset.palletId IS NOT NULL');
    }
    if (query.onPallet === 'false') {
      qb.andWhere('asset.palletId IS NULL');
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
      .leftJoinAndSelect('asset.pallet', 'pallet')
      .leftJoinAndSelect('asset.owner', 'owner')
      .addSelect('asset.hardwareProfile')
      .where('asset.id = :id', { id });
    // For a scoped manager, an asset outside their batches is treated as
    // not-found (don't reveal it exists). Admins/technicians/internal: no filter.
    if (isScopedManager(user)) {
      qb.innerJoin('asset.batch', 'ownerBatch').andWhere(managerBatchCondition('ownerBatch'), {
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

  async create(dto: CreateAssetDto, user?: RequestUser): Promise<Asset> {
    // Managers can only create assets inside a lot they own.
    await this.assertOwnsTargetLot(dto.batchId ?? null, user);
    const userId = user?.userId;
    const asset = await this.assets.save(
      this.assets.create({ ...dto, unitId: await nextUnitId(this.assets) }),
    );
    if (userId) await this.logEvent(asset.id, AssetEventType.CREATED, userId, 'Asset created');
    await this.activity.record({
      userId,
      action: 'asset.created',
      entityType: 'asset',
      entityId: asset.id,
      summary: `Created ${asset.name}`,
    });
    return asset;
  }

  async update(id: string, dto: UpdateAssetDto, user?: RequestUser): Promise<Asset> {
    // 404s for a scoped manager who doesn't own the asset's current lot.
    const before = await this.findOne(id, user);
    // A sold asset is locked: no edits or moves except by an admin (who should
    // normally use the return flow rather than editing in place).
    if (before.stockStatus === AssetStockStatus.SOLD && user && user.role !== 'admin') {
      throw new ForbiddenException('This asset is sold and locked. Ask an admin to return it.');
    }
    // If moving to a different lot, a manager must own the destination too.
    if (dto.batchId !== undefined && dto.batchId !== before.batchId) {
      await this.assertOwnsTargetLot(dto.batchId, user);
    }
    const userId = user?.userId;

    await this.assets.update(id, dto);
    // Re-read without scoping so a move that lands the asset in the target lot
    // (already ownership-checked above) still returns it.
    const after = await this.findOne(id);

    if (userId && dto.stockStatus && dto.stockStatus !== before.stockStatus) {
      await this.logEvent(
        id,
        AssetEventType.STATUS_CHANGED,
        userId,
        `${before.stockStatus} -> ${after.stockStatus}`,
      );
    }
    if (userId && dto.conditionGrade && dto.conditionGrade !== before.conditionGrade) {
      await this.logEvent(
        id,
        AssetEventType.CONDITION_CHANGED,
        userId,
        `${before.conditionGrade ?? 'ungraded'} -> ${after.conditionGrade}`,
      );
    }
    // `locationId in dto` rather than a truthiness test: clearing a location
    // back to Unassigned is a move too, and a falsy check silently skipped it.
    if (userId && 'locationId' in dto && dto.locationId !== before.locationId) {
      await this.logEvent(
        id,
        AssetEventType.TRANSFERRED,
        userId,
        // Names, not ids — this string is read by a human on the History list,
        // where "location 8f3c… -> 91ab…" told them nothing.
        `Moved from ${before.location?.name ?? 'no location'} to ${after.location?.name ?? 'no location'}`,
      );
    }

    // High-level feed entry. If the batch changed, call it a move; else an edit.
    // Two different kinds of move, and neither should read as "Edited" in the
    // activity feed. A location change used to, because `moved` only looked at
    // the lot — so a transfer was invisible on the dashboard's Recent activity.
    const movedLot = dto.batchId !== undefined && dto.batchId !== before.batchId;
    const movedSite = 'locationId' in dto && dto.locationId !== before.locationId;
    await this.activity.record({
      userId,
      action: movedLot || movedSite ? 'asset.moved' : 'asset.updated',
      entityType: 'asset',
      entityId: id,
      summary: movedLot
        ? `Moved ${after.name} to another lot`
        : movedSite
          ? `Moved ${after.name} to ${after.location?.name ?? 'no location'}`
          : `Edited ${after.name}`,
    });

    return after;
  }

  // Records a full ITAD audit event and denormalizes its condition/audit
  // outcome onto the asset itself, so list views can filter by "latest
  // grade" without joining the full audit history every time.
  async createAudit(assetId: string, dto: CreateAssetAuditDto, userId: string): Promise<AssetAudit> {
    const asset = await this.findOne(assetId); // 404s if the asset doesn't exist

    // Same normalisation the USB tool's ingest path applies, so an audit typed
    // into the web form can't reintroduce a 15 GB capacity or put a screen size
    // on a tower. deviceType falls back to category for rows captured before
    // deviceType existed. See common/spec-normalise.ts.
    const audit = await this.audits.save(
      this.audits.create({
        ...dto,
        ...(dto.ramGb !== undefined ? { ramGb: standardiseRamGb(dto.ramGb) } : {}),
        ...(dto.screenSize !== undefined
          ? { screenSize: screenSizeFor(asset.deviceType ?? asset.category, dto.screenSize) }
          : {}),
        assetId,
        auditedById: userId,
      }),
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

  // The Sold archive: every sold asset, newest first, with the provenance the
  // Sold page shows (lot, sub-lot, product spec, who sold it and when).
  async findSold(): Promise<Asset[]> {
    return this.assets
      .createQueryBuilder('asset')
      .leftJoinAndSelect('asset.batch', 'batch')
      .leftJoinAndSelect('asset.lot', 'lot')
      .leftJoinAndSelect('asset.product', 'product')
      .leftJoinAndSelect('asset.soldBy', 'soldBy')
      .where('asset.stockStatus = :sold', { sold: AssetStockStatus.SOLD })
      .orderBy('asset.soldAt', 'DESC')
      .getMany()
      .then((assets) =>
        assets.map((a) => {
          if (a.soldBy) a.soldBy = sanitizeUser(a.soldBy) as Asset['soldBy'];
          return a;
        }),
      );
  }

  // Mark as Sold: terminal status, out of every active view, locked for
  // non-admins. The batch/lot links stay for provenance and the return path.
  async sell(id: string, user: RequestUser, salePrice?: number): Promise<Asset> {
    const before = await this.findOne(id, user);
    if (before.stockStatus === AssetStockStatus.SOLD) {
      throw new ConflictException('This asset is already sold.');
    }
    await this.assets.update(id, {
      stockStatus: AssetStockStatus.SOLD,
      soldAt: new Date(),
      soldById: user.userId,
      salePrice: salePrice != null && salePrice >= 0 ? salePrice : null,
      // A sold device has physically left the building, so it leaves its
      // pallet too -- otherwise the pallet's device count claims stock that
      // is gone. The sell event in history records who and when.
      palletId: null,
      movedToPalletAt: null,
      movedToPalletById: null,
    });
    await this.logEvent(
      id,
      AssetEventType.STATUS_CHANGED,
      user.userId,
      `${before.stockStatus} -> sold (marked as Sold)`,
    );
    await this.activity.record({
      userId: user.userId,
      action: 'asset.sold',
      entityType: 'asset',
      entityId: id,
      summary: `Sold ${before.name} (${before.tag})`,
    });
    return this.findOne(id);
  }

  // Admin-only return: back to active inventory, optionally into a different
  // lot. Clears the sold stamp; history records where it came back from.
  async returnFromSold(id: string, batchId: string | null | undefined, user: RequestUser): Promise<Asset> {
    const before = await this.findOne(id);
    if (before.stockStatus !== AssetStockStatus.SOLD) {
      throw new ConflictException('This asset is not sold.');
    }
    const targetBatch = batchId === undefined ? before.batchId : batchId;
    const movingLots = targetBatch !== before.batchId;
    await this.assets.update(id, {
      stockStatus: AssetStockStatus.IN_STOCK,
      soldAt: null,
      soldById: null,
      salePrice: null, // the sale was undone
      batchId: targetBatch,
      ...(movingLots ? { lotId: null } : {}),
    });
    // Mirror of the pallet rule: a lot that was sold wholesale but just got a
    // device back holds active inventory again — reopen it.
    if (targetBatch) {
      const destBatch = await this.batches.findOne({ where: { id: targetBatch } });
      if (destBatch?.status === BatchStatus.SOLD) {
        await this.batches.update(targetBatch, { status: BatchStatus.OPEN });
      }
    }
    await this.logEvent(
      id,
      AssetEventType.STATUS_CHANGED,
      user.userId,
      `sold -> in_stock (returned to inventory${movingLots ? ', moved lot' : ''})`,
    );
    await this.activity.record({
      userId: user.userId,
      action: 'asset.returned',
      entityType: 'asset',
      entityId: id,
      summary: `Returned ${before.name} (${before.tag}) to inventory`,
    });
    return this.findOne(id);
  }

  // Bulk return for the Sold page: batchId omitted -> each asset goes back to
  // its own original lot; batchId given -> all go to that lot. Per-item
  // failures (e.g. already returned in another tab) are skipped, not fatal.
  async bulkReturnFromSold(
    assetIds: string[],
    batchId: string | undefined,
    user: RequestUser,
  ): Promise<{ returned: number; skipped: number }> {
    let returned = 0;
    let skipped = 0;
    for (const id of assetIds) {
      try {
        await this.returnFromSold(id, batchId, user);
        returned += 1;
      } catch {
        skipped += 1;
      }
    }
    return { returned, skipped };
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
