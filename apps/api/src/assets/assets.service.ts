import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset, AssetStockStatus } from './asset.entity';
import { AVAILABLE, GONE as GONE_STATUSES } from './stock-status';
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

// --- Lifecycle states -------------------------------------------------------
//
// The register's tabs and its status pill describe a DERIVED state, not a
// stored column: a device's place in the ITAD lifecycle is a reading of its
// stock status and its audit verdict together. Defined once here, mirrored in
// the web's lib/asset-lifecycle.ts for the pill, and kept honest by an E2E
// check that every row a tab returns renders that tab's pill.
//
// Precedence matters and is encoded in the predicates: sold outranks
// everything (a sold device is SOLD whatever its verdict said), and quarantine
// outranks the verdict (a failed wipe is not merely "audited"). The states
// therefore partition the register — every device is in exactly one.
// Devices that have LEFT the building. Same vocabulary the dashboard uses
// (dashboard.service.ts GONE) — a unit can leave by sale, by dispatch, or by
// destruction, and none of those is live stock. Classifying only 'sold' as
// terminal put a recycled machine that had been graded under "Ready", with an
// emerald pill, as if it were sellable. 'shipped' is written by the sales
// service and 'disposed' is settable from the asset edit form, so both are
// reachable states, not theoretical ones.
// Built from the shared list rather than restated, so this predicate and the
// `held=true` filter below can never fall out of step.
const GONE = `asset.stockStatus IN (${GONE_STATUSES.map((s) => `'${s}'`).join(', ')})`;
const NOT_SOLD = `asset.stockStatus != 'sold'`;
// IS NOT DISTINCT FROM, not `=`: audit_status is nullable, and in SQL
// `NULL = 'data_wipe_failed'` is NULL, so `(false OR NULL)` is NULL and
// `NOT NULL` is NULL — which is not TRUE. A bare comparison therefore dropped
// every never-audited device out of EVERY live tab: they vanished from the
// register instead of appearing under "In processing". NULL-safe equality
// always yields TRUE or FALSE. (A ::text cast would also work, but TypeORM
// cannot map an aliased property through a cast — it looks for a column
// literally named "auditStatus" and the query 500s.)
const QUARANTINED = `(asset.stockStatus = 'quarantined' OR asset.auditStatus IS NOT DISTINCT FROM 'data_wipe_failed')`;
const LIVE = `NOT ${GONE} AND NOT ${QUARANTINED}`;

export const LIFECYCLE_PREDICATES: Record<string, string> = {
  // 'all' is the only view with no restriction at all — the register is the
  // identity record of every unit that ever existed, so it shows devices that
  // have left (sold, shipped, disposed) alongside live stock. Every other
  // value is a state in the live pipeline, plus 'sold' for the archive.
  all: '',
  sold: `asset.stockStatus = 'sold'`,
  quarantine: `NOT ${GONE} AND ${QUARANTINED}`,
  ready: `${LIVE} AND asset.auditStatus = 'ready_for_sale'`,
  wiped: `${LIVE} AND asset.auditStatus = 'data_wiped'`,
  audited: `${LIVE} AND asset.auditStatus IS NOT NULL AND asset.auditStatus NOT IN ('ready_for_sale', 'data_wiped')`,
  in_processing: `${LIVE} AND asset.auditStatus IS NULL`,
};

export interface AssetSummary {
  assets: number;
  held: number;
  wiped: number;
  ready: number;
  sold: number;
  quarantine: number;
}

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
    // ...and the pallet a sold device came off, so the register can answer
    // "sold from where?" for a device whose live allocation was cleared.
    // Identity only — this is a label, not a claim on stock.
    qb.leftJoin('asset.soldFromPallet', 'soldFromPallet').addSelect([
      'soldFromPallet.id',
      'soldFromPallet.palletNumber',
    ]);
    // The register's Lot column and the typed lot search need the batch, but
    // list rows only carry its identity — not costs or notes. Joined under its
    // own alias; the manager-scoping innerJoin above keeps 'ownerBatch'.
    qb.leftJoin('asset.batch', 'batch').addSelect(['batch.id', 'batch.batchNumber']);
    // Sold assets are out of active inventory: excluded from every list/search
    // unless the caller explicitly filters by a status (e.g. the Sold archive
    // asking for stockStatus=sold) — or asks for a lifecycle view, which
    // states its own position on sold devices.
    if (!query.stockStatus && !query.lifecycle) {
      qb.andWhere('asset.stockStatus != :soldStatus', { soldStatus: AssetStockStatus.SOLD });
    }
    if (query.lifecycle) {
      const predicate = LIFECYCLE_PREDICATES[query.lifecycle];
      // Unknown values can't reach here (the DTO validates the set), and 'all'
      // is deliberately empty — no restriction at all.
      if (predicate) qb.andWhere(`(${predicate})`);
    }

    if (query.search) {
      // Identity search (§7 register redesign): a typed lot number, pallet
      // number or location name resolves too — warehouse staff search by what
      // is written on the thing in front of them, not by internal UUIDs.
      qb.andWhere(
        '(asset.tag ILIKE :search OR asset.unitId ILIKE :search OR asset.name ILIKE :search OR asset.serialNumber ILIKE :search OR asset.expressServiceCode ILIKE :search OR asset.manufacturer ILIKE :search OR asset.model ILIKE :search OR batch.batchNumber ILIKE :search OR pallet.palletNumber ILIKE :search OR location.name ILIKE :search)',
        { search: `%${query.search}%` },
      );
    }
    if (query.category) {
      qb.andWhere('asset.category = :category', { category: query.category });
    }
    if (query.stockStatus) {
      qb.andWhere('asset.stockStatus = :stockStatus', { stockStatus: query.stockStatus });
    }
    // The same AVAILABLE set the dashboard's "In stock" tile counts, so the
    // figure and the list it links to are one query. Sold/shipped/disposed are
    // excluded by construction — AVAILABLE names only held statuses — so this
    // does not lean on the sold-exclusion rule above.
    if (query.available === 'true') {
      qb.andWhere('asset.stockStatus IN (:...availableStatuses)', {
        availableStatuses: [...AVAILABLE],
      });
    }
    // Everything that has not left the building. Quarantined and committed
    // devices ARE held — they are still on site — so this is deliberately
    // wider than `available`.
    if (query.held === 'true') {
      qb.andWhere('asset.stockStatus NOT IN (:...goneStatuses)', {
        goneStatuses: [...GONE_STATUSES],
      });
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
    if (query.noSerial === 'true') {
      // Empty string counts as missing: a capture that reported a blank serial
      // is as unidentifiable as one that reported none.
      qb.andWhere("(asset.serialNumber IS NULL OR asset.serialNumber = '')");
    }
    // Palletised devices STAY in the register (labels must keep scanning to a
    // hit) -- this filter is how the Goods In pool excludes them instead.
    if (query.onPallet === 'true') {
      qb.andWhere('asset.palletId IS NOT NULL');
    }
    if (query.onPallet === 'false') {
      qb.andWhere('asset.palletId IS NULL');
    }
    if (query.palletId) {
      qb.andWhere('asset.palletId = :palletId', { palletId: query.palletId });
    }
    if (query.lotId) {
      qb.andWhere('asset.lotId = :lotId', { lotId: query.lotId });
    }

    return qb.getMany();
  }

  // The register's headline counts. Computed in SQL over the whole register
  // (not over a loaded page), and from the SAME predicates the tabs filter by,
  // so a card can never disagree with the tab beside it. Manager scoping is
  // the same rule every other list applies.
  async summary(user?: RequestUser): Promise<AssetSummary> {
    const qb = this.assets.createQueryBuilder('asset');
    if (isScopedManager(user)) {
      qb.innerJoin('asset.batch', 'ownerBatch').andWhere(managerBatchCondition('ownerBatch'), {
        ownerUid: user!.userId,
      });
    }
    const count = (predicate: string) =>
      predicate ? `COUNT(*) FILTER (WHERE ${predicate})` : 'COUNT(*)';
    const row = await qb
      .select(count(''), 'assets')
      // Everything still in the building: not sold, not shipped, not disposed.
      // Deliberately NOT called "in stock" on the page — the dashboard's tile
      // of that name counts a narrower set (its AVAILABLE list), and two
      // pages showing different numbers under one label is a support ticket.
      .addSelect(count(`NOT ${GONE}`), 'held')
      .addSelect(count(LIFECYCLE_PREDICATES.wiped), 'wiped')
      .addSelect(count(LIFECYCLE_PREDICATES.ready), 'ready')
      .addSelect(count(LIFECYCLE_PREDICATES.sold), 'sold')
      .addSelect(count(LIFECYCLE_PREDICATES.quarantine), 'quarantine')
      .getRawOne<Record<string, string>>();

    const n = (v: string | undefined) => Number(v ?? 0);
    return {
      assets: n(row?.assets),
      held: n(row?.held),
      wiped: n(row?.wiped),
      ready: n(row?.ready),
      sold: n(row?.sold),
      quarantine: n(row?.quarantine),
    };
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
      // is gone. Where it sat is kept as history on sold_from_pallet_id,
      // which nothing counts, so the record survives without the claim.
      soldFromPalletId: before.palletId ?? before.soldFromPalletId ?? null,
      palletId: null,
      movedToPalletAt: null,
      movedToPalletById: null,
    });
    await this.logEvent(
      id,
      AssetEventType.STATUS_CHANGED,
      user.userId,
      // Name the pallet it was sold OFF. The allocation itself has to be
      // cleared above (an open pallet must not keep claiming stock that has
      // gone), which destroys the only record of where the device sat — so
      // the trail has to carry it, or "which pallet did this sell from?"
      // becomes unanswerable.
      `${before.stockStatus} -> sold (marked as Sold${
        before.pallet ? `, from ${before.pallet.palletNumber}` : ''
      })`,
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
      // A device sold WITH a pallet kept its link as the shipped manifest;
      // undoing the sale brings the device back WITHOUT the pallet — it
      // returns to its lot's pool, and the shipped pallet's record shrinks
      // accordingly. "Sold from" goes with it: the device is live stock again,
      // so there is no sale for it to have come from.
      soldFromPalletId: null,
      palletId: null,
      movedToPalletAt: null,
      movedToPalletById: null,
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
