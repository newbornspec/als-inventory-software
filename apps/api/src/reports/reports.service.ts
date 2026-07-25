import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset, AssetAuditStatus, AssetConditionGrade, AssetStockStatus } from '../assets/asset.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import { Batch } from '../batches/batch.entity';
import { Lot } from '../batches/lot.entity';
import { OrderLine } from '../sales/order-line.entity';
import { RepairLog, RepairStatus } from '../repairs/repair-log.entity';
import { StockLine } from '../stock/stock-line.entity';
import { Pallet, PalletStatus } from '../pallets/pallet.entity';
import { PalletLine } from '../pallets/pallet-line.entity';
import { PalletSoldLine } from '../pallets/pallet-sold-line.entity';
import { User } from '../users/user.entity';
import { IsNull } from 'typeorm';
import { stockStatusFor } from '../stock/stock.service';
import { accessibleBatchWhere, isScopedManager, type RequestUser } from '../common/ownership';

export interface Notification {
  id: string;
  type: 'quarantined' | 'repair_required' | 'ber' | 'out_of_stock' | 'low_stock';
  severity: 'critical' | 'warning';
  message: string;
  href: string; // where clicking the alert goes
}

// One row of the lot-profitability report. Revenue and cost-of-sold cover only
// the units actually shipped, so profit is realized (not speculative). totalCost
// is shown alongside so a lot with cost still to recoup is obvious.
export interface LotProfit {
  batchId: string;
  batchNumber: string;
  source: string | null;
  totalCost: number | null;
  units: number;
  unitsSold: number;
  revenue: number;
  costOfSold: number;
  profit: number;
  margin: number | null;
}

// Per-asset cost/profit — the same even-split-with-override basis as the lot
// report, resolved for a single unit and joined to the order it sold on.
export interface AssetCosting {
  assetId: string;
  purchaseCost: number | null; // manual override, if set
  lotTotalCost: number | null;
  unitsInLot: number;
  evenSplit: number | null;
  allocatedCost: number | null; // override ?? even split
  repairsCost: number; // total of this unit's COMPLETED repair jobs
  salePrice: number | null; // from the order line, if on one
  sold: boolean;
  profit: number | null; // salePrice - allocatedCost - repairsCost, when sold and known
  orderId: string | null;
  orderNumber: string | null;
}

// The Reports dashboard roll-up: KPI cards + active-inventory breakdowns.
export interface OverviewReport {
  kpis: {
    totalAssets: number;
    activeAssets: number;
    inStock: number;
    awaitingAudit: number;
    readyForSale: number;
    soldUnits: number; // within range: devices + pallet quantities
    lots: number;
    subLots: number;
    activePallets: number;
    palletUnits: number;
    consumableItems: number;
    consumableUnits: number;
    warehouseValue: number;
    revenue: number; // within range
    costOfSold: number; // within range
    profit: number; // within range
    marginPct: number | null;
    users: number;
  };
  byCategory: { label: string; count: number }[];
  byManufacturer: { label: string; count: number; pct: number; avgGrade: string | null }[];
  byGrade: { label: string; count: number }[];
  byAuditStatus: { label: string; count: number }[];
}

const GRADE_LABELS: Record<string, string> = {
  grade_a: 'Grade A',
  grade_b: 'Grade B',
  grade_c: 'Grade C',
  grade_d: 'Grade D',
  for_parts: 'For Parts',
  scrap: 'Scrap',
};

const GRADE_POINTS: Record<string, number> = { grade_a: 4, grade_b: 3, grade_c: 2, grade_d: 1 };
function gradeLetter(avg: number): string {
  return avg >= 3.5 ? 'A' : avg >= 2.5 ? 'B' : avg >= 1.5 ? 'C' : 'D';
}

// Warehouse operations throughput over the range. Counts are of history
// events (a device can be received once, audited, then sold — each is one
// event). avgProcessingDays is intake→first-audit, over assets audited in the
// range, so it measures how fast stock is being worked.
export interface WarehouseThroughput {
  metrics: {
    received: number;
    scanned: number;
    audited: number;
    shipped: number;
    sold: number;
    returned: number;
  };
  processedAssets: number; // distinct assets audited in range
  avgProcessingDays: number | null;
  daily: { date: string; count: number }[]; // throughput events per day over the window
  windowLabel: string;
}

// Batch → sub-lot performance for the Reports drill-down. Counts/cost are
// lifetime snapshots; revenue/profit/unitsSold respect the from/to range.
// (Pallets aren't children of batches in this data model — the hierarchy is
// Batch → Sub-lot → Assets — so there's no per-batch pallet count.)
export interface BatchAnalytics {
  batchId: string;
  batchNumber: string;
  owner: string | null; // assigned owner
  createdBy: string | null;
  source: string | null; // supplier
  createdAt: string;
  status: string;
  totalSubLots: number;
  totalAssets: number;
  unitsSold: number;
  totalCost: number | null;
  revenue: number;
  profit: number;
  marginPct: number | null;
  subLots: {
    lotId: string | null;
    lotNumber: string;
    description: string | null;
    assets: number;
    sold: number;
    cost: number;
    revenue: number;
    avgGrade: string | null;
    completionPct: number; // audited / total
  }[];
}

// Sales & finance analytics. Summary + top-lists respect the from/to range;
// the monthly trend is a rolling 12-month window (a trend needs several months
// to read). Device sales draw sale_price + allocated cost; pallet goods draw
// sale_total + the snapshotted unit cost.
export interface SalesAnalytics {
  summary: {
    soldUnits: number;
    revenue: number;
    cost: number;
    profit: number;
    marginPct: number | null;
    avgSellPrice: number | null; // over priced units only
    soldToday: number;
    soldThisMonth: number;
  };
  monthly: { month: string; revenue: number; profit: number; units: number }[];
  topManufacturers: { label: string; units: number; revenue: number }[];
  topModels: { label: string; units: number; revenue: number }[];
  topCategories: { label: string; units: number; revenue: number }[];
  bySupplier: { label: string; units: number; revenue: number; cost: number; profit: number; marginPct: number | null }[];
}

// Management dashboard roll-up — a single aggregated snapshot.
export interface DashboardSummary {
  totalDevices: number;
  inStock: number;
  sold: number;
  sellThroughPct: number | null;
  revenue: number; // realized (shipped units)
  realizedProfit: number; // revenue − cost of sold − repairs on sold
  stockAtCost: number; // allocated cost of unsold, in-stock devices
  byStatus: { key: string; count: number }[];
  byGrade: { key: string; count: number }[];
  ageing: { key: string; count: number }[]; // in-stock devices by age
  repairs: { pending: number; inProgress: number; completed: number; spend: number };
  lots: { total: number; reconciled: number };
  consumables: { total: number; lowStock: number; outOfStock: number };
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetHistory) private history: Repository<AssetHistory>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
    @InjectRepository(Lot) private lots: Repository<Lot>,
    @InjectRepository(OrderLine) private lines: Repository<OrderLine>,
    @InjectRepository(RepairLog) private repairLogs: Repository<RepairLog>,
    @InjectRepository(StockLine) private stockLines: Repository<StockLine>,
    @InjectRepository(Pallet) private pallets: Repository<Pallet>,
    @InjectRepository(PalletLine) private palletLines: Repository<PalletLine>,
    @InjectRepository(PalletSoldLine) private palletSold: Repository<PalletSoldLine>,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  // The batch ids a scoped manager owns; null means "no restriction"
  // (admins/technicians and internal callers see everything).
  private async ownedBatchIds(user?: RequestUser): Promise<Set<string> | null> {
    if (!isScopedManager(user)) return null;
    const rows = await this.batches.find({
      where: accessibleBatchWhere(user),
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  // Profit per purchase lot (D6). Per-unit cost = the asset's manual override if
  // set, else an even split of the lot's total_cost across the lot's units.
  async getLotProfitability(user?: RequestUser): Promise<LotProfit[]> {
    let [batches, assets] = await Promise.all([
      this.batches.find({ order: { createdAt: 'DESC' } }),
      this.assets.find(),
    ]);
    const lines = await this.lines.find();
    const owned = await this.ownedBatchIds(user);
    if (owned) {
      batches = batches.filter((b) => owned.has(b.id));
      assets = assets.filter((a) => a.batchId != null && owned.has(a.batchId));
    }

    // Realized sale value per asset (a shipped serial has exactly one line).
    const saleByAsset = new Map<string, number>();
    for (const l of lines) {
      if (!l.assetId) continue;
      const amount = (l.unitPrice ?? 0) * l.quantity;
      saleByAsset.set(l.assetId, (saleByAsset.get(l.assetId) ?? 0) + amount);
    }

    const byBatch = new Map<string, Asset[]>();
    for (const a of assets) {
      if (!a.batchId) continue;
      const arr = byBatch.get(a.batchId) ?? [];
      arr.push(a);
      byBatch.set(a.batchId, arr);
    }

    return batches.map((b) => {
      const units = byBatch.get(b.id) ?? [];
      const evenSplit = b.totalCost != null && units.length > 0 ? b.totalCost / units.length : null;
      const sold = units.filter(
        (a) =>
          a.stockStatus === AssetStockStatus.SHIPPED ||
          a.stockStatus === AssetStockStatus.SOLD,
      );
      const revenue = sold.reduce((s, a) => s + (saleByAsset.get(a.id) ?? 0), 0);
      const costOfSold = sold.reduce((s, a) => s + (a.purchaseCost ?? evenSplit ?? 0), 0);
      const profit = revenue - costOfSold;
      return {
        batchId: b.id,
        batchNumber: b.batchNumber,
        source: b.source,
        totalCost: b.totalCost,
        units: units.length,
        unitsSold: sold.length,
        revenue: round2(revenue),
        costOfSold: round2(costOfSold),
        profit: round2(profit),
        margin: revenue > 0 ? round2(profit / revenue) : null,
      };
    });
  }

  async getAssetCosting(assetId: string, user?: RequestUser): Promise<AssetCosting> {
    const asset = await this.assets.findOne({ where: { id: assetId } });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);
    // A scoped manager can only cost an asset in a lot they own.
    const owned = await this.ownedBatchIds(user);
    if (owned && !(asset.batchId != null && owned.has(asset.batchId))) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }

    let lotTotalCost: number | null = null;
    let unitsInLot = 0;
    let evenSplit: number | null = null;
    if (asset.batchId) {
      const [batch, count] = await Promise.all([
        this.batches.findOne({ where: { id: asset.batchId } }),
        this.assets.countBy({ batchId: asset.batchId }),
      ]);
      lotTotalCost = batch?.totalCost ?? null;
      unitsInLot = count;
      evenSplit = lotTotalCost != null && count > 0 ? round2(lotTotalCost / count) : null;
    }
    const allocatedCost = asset.purchaseCost ?? evenSplit;

    // Completed repair jobs are a real cost of getting this unit to sale.
    const repairRows = await this.repairLogs.find({
      where: { assetId, status: RepairStatus.COMPLETED },
    });
    const repairsCost = round2(repairRows.reduce((s, r) => s + (r.cost ?? 0), 0));

    const line = await this.lines.findOne({ where: { assetId }, relations: ['order'] });
    const salePrice = line ? (line.unitPrice ?? 0) * line.quantity : null;
    const sold = asset.stockStatus === AssetStockStatus.SHIPPED;
    const profit =
      sold && salePrice != null && allocatedCost != null
        ? round2(salePrice - allocatedCost - repairsCost)
        : null;

    return {
      assetId,
      purchaseCost: asset.purchaseCost ?? null,
      lotTotalCost,
      unitsInLot,
      evenSplit,
      allocatedCost,
      repairsCost,
      salePrice,
      sold,
      profit,
      orderId: line?.order?.id ?? null,
      orderNumber: line?.order?.orderNumber ?? null,
    };
  }

  async exportProfitCsv(user?: RequestUser): Promise<string> {
    const rows = await this.getLotProfitability(user);
    const header = [
      'lot',
      'source',
      'total_cost',
      'units',
      'units_sold',
      'revenue',
      'cost_of_sold',
      'profit',
      'margin_pct',
    ];
    const body = rows.map((r) =>
      [
        r.batchNumber,
        r.source ?? '',
        r.totalCost ?? '',
        String(r.units),
        String(r.unitsSold),
        r.revenue.toFixed(2),
        r.costOfSold.toFixed(2),
        r.profit.toFixed(2),
        r.margin == null ? '' : (r.margin * 100).toFixed(1),
      ]
        .map((v) => csvEscape(String(v)))
        .join(','),
    );
    return [header.join(','), ...body].join('\n');
  }

  // The Reports dashboard's single roll-up: KPI cards + inventory breakdowns.
  // Snapshot metrics (stock, value, breakdowns) are current-state; sales
  // metrics (sold/revenue/cost/profit) respect the from/to range on sold_at.
  async getOverview(from?: Date, to?: Date, user?: RequestUser): Promise<OverviewReport> {
    let [assets, batches, lotsCount, activePalletsList, pLines, pSold, stock, usersCount] =
      await Promise.all([
        this.assets
          .createQueryBuilder('a')
          .select([
            'a.id', 'a.batchId', 'a.category', 'a.manufacturer', 'a.purchaseCost', 'a.salePrice',
            'a.stockStatus', 'a.conditionGrade', 'a.auditStatus', 'a.soldAt',
          ])
          .getMany(),
        this.batches.find(),
        this.lots.count(),
        this.pallets.find({ where: {} }),
        this.palletLines.find(),
        this.palletSold.find({ where: { returnedAt: IsNull() } }),
        this.stockLines.find({ select: { id: true, quantity: true } }),
        this.users.count(),
      ]);

    const owned = await this.ownedBatchIds(user);
    if (owned) {
      batches = batches.filter((b) => owned.has(b.id));
      assets = assets.filter((a) => a.batchId != null && owned.has(a.batchId));
    }

    const unitsPerBatch = new Map<string, number>();
    for (const a of assets) {
      if (a.batchId) unitsPerBatch.set(a.batchId, (unitsPerBatch.get(a.batchId) ?? 0) + 1);
    }
    const batchTotalCost = new Map(batches.map((b) => [b.id, b.totalCost]));
    const allocated = (a: Asset): number => {
      if (a.purchaseCost != null) return a.purchaseCost;
      if (a.batchId) {
        const tc = batchTotalCost.get(a.batchId);
        const u = unitsPerBatch.get(a.batchId) ?? 0;
        if (tc != null && u > 0) return tc / u;
      }
      return 0;
    };

    const inRange = (d: Date | string | null | undefined): boolean => {
      if (!d) return false;
      const t = new Date(d).getTime();
      if (from && t < from.getTime()) return false;
      if (to && t > to.getTime()) return false;
      return true;
    };

    const active = assets.filter((a) => a.stockStatus !== AssetStockStatus.SOLD);
    const soldAssetsInRange = assets.filter(
      (a) => a.stockStatus === AssetStockStatus.SOLD && inRange(a.soldAt),
    );
    const soldRowsInRange = pSold.filter((r) => inRange(r.soldAt));

    const revenue =
      soldAssetsInRange.reduce((s, a) => s + (a.salePrice ?? 0), 0) +
      soldRowsInRange.reduce((s, r) => s + (r.saleTotal ?? 0), 0);
    const costOfSold =
      soldAssetsInRange.reduce((s, a) => s + allocated(a), 0) +
      soldRowsInRange.reduce((s, r) => s + (r.unitCost != null ? r.unitCost * r.quantity : 0), 0);
    const profit = revenue - costOfSold;

    const activePallets = activePalletsList.filter((p) => p.status !== PalletStatus.SHIPPED);
    const palletUnits = pLines.reduce((s, l) => s + l.quantity, 0);
    const warehouseValue =
      active
        .filter((a) => a.stockStatus !== AssetStockStatus.DISPOSED)
        .reduce((s, a) => s + allocated(a), 0) +
      pLines.reduce((s, l) => s + (l.unitCost != null ? l.unitCost * l.quantity : 0), 0);

    // Breakdowns cover ACTIVE (unsold) inventory — that's what's on the floor.
    const tally = (key: (a: Asset) => string): Map<string, number> => {
      const m = new Map<string, number>();
      for (const a of active) {
        const k = key(a);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };
    const toRows = (m: Map<string, number>) =>
      [...m.entries()].map(([label, count]) => ({ label, count })).sort((x, y) => y.count - x.count);

    const gradePoints: Record<string, number> = {
      [AssetConditionGrade.GRADE_A]: 4,
      [AssetConditionGrade.GRADE_B]: 3,
      [AssetConditionGrade.GRADE_C]: 2,
      [AssetConditionGrade.GRADE_D]: 1,
    };
    const gradeLetter = (avg: number): string =>
      avg >= 3.5 ? 'A' : avg >= 2.5 ? 'B' : avg >= 1.5 ? 'C' : 'D';

    const manMap = new Map<string, { count: number; points: number; graded: number }>();
    for (const a of active) {
      const k = a.manufacturer?.trim() || 'Unknown';
      const e = manMap.get(k) ?? { count: 0, points: 0, graded: 0 };
      e.count += 1;
      const p = a.conditionGrade ? gradePoints[a.conditionGrade] : undefined;
      if (p != null) {
        e.points += p;
        e.graded += 1;
      }
      manMap.set(k, e);
    }
    const byManufacturer = [...manMap.entries()]
      .map(([label, e]) => ({
        label,
        count: e.count,
        pct: active.length > 0 ? round2((e.count / active.length) * 100) : 0,
        avgGrade: e.graded > 0 ? gradeLetter(e.points / e.graded) : null,
      }))
      .sort((x, y) => y.count - x.count);

    return {
      kpis: {
        totalAssets: assets.length,
        activeAssets: active.length,
        inStock: active.filter((a) => a.stockStatus === AssetStockStatus.IN_STOCK).length,
        awaitingAudit: active.filter((a) => a.auditStatus == null).length,
        readyForSale: active.filter((a) => a.auditStatus === AssetAuditStatus.READY_FOR_SALE).length,
        soldUnits: soldAssetsInRange.length + soldRowsInRange.reduce((s, r) => s + r.quantity, 0),
        lots: batches.length,
        subLots: lotsCount,
        activePallets: activePallets.length,
        palletUnits,
        consumableItems: stock.length,
        consumableUnits: stock.reduce((s, x) => s + x.quantity, 0),
        warehouseValue: round2(warehouseValue),
        revenue: round2(revenue),
        costOfSold: round2(costOfSold),
        profit: round2(profit),
        marginPct: revenue > 0 ? round2((profit / revenue) * 100) : null,
        users: usersCount,
      },
      byCategory: toRows(tally((a) => a.category?.trim() || 'Uncategorised')),
      byGrade: toRows(tally((a) => GRADE_LABELS[a.conditionGrade ?? ''] ?? 'Ungraded')),
      byAuditStatus: toRows(tally((a) => a.auditStatus ?? 'not_audited')),
      byManufacturer,
    };
  }

  async getWarehouseThroughput(
    from?: Date,
    to?: Date,
    user?: RequestUser,
  ): Promise<WarehouseThroughput> {
    // Manager scoping: only events for assets in lots they own.
    let ownedAssetIds: Set<string> | null = null;
    const owned = await this.ownedBatchIds(user);
    if (owned) {
      if (owned.size === 0) ownedAssetIds = new Set();
      else {
        const rows = await this.assets
          .createQueryBuilder('a')
          .select(['a.id'])
          .where('a.batch_id IN (:...ids)', { ids: [...owned] })
          .getMany();
        ownedAssetIds = new Set(rows.map((r) => r.id));
      }
    }

    // Full history (assetId/eventType/notes/createdAt only). Fine at current
    // scale; a large deployment would push the bucketing into SQL.
    let events = await this.history
      .createQueryBuilder('h')
      .select(['h.assetId', 'h.eventType', 'h.notes', 'h.createdAt'])
      .getMany();
    if (ownedAssetIds) events = events.filter((e) => ownedAssetIds!.has(e.assetId));

    const inRange = (d: Date | string): boolean => {
      const t = new Date(d).getTime();
      if (from && t < from.getTime()) return false;
      if (to && t > to.getTime()) return false;
      return true;
    };
    const notes = (e: AssetHistory) => e.notes ?? '';

    let received = 0, scanned = 0, audited = 0, shipped = 0, sold = 0, returned = 0;
    const auditedAssets = new Set<string>();
    for (const e of events) {
      if (!inRange(e.createdAt)) continue;
      if (e.eventType === 'created') received += 1;
      else if (e.eventType === 'scanned') scanned += 1;
      else if (e.eventType === 'audited') {
        audited += 1;
        auditedAssets.add(e.assetId);
      } else if (e.eventType === 'status_changed') {
        const n = notes(e);
        if (n.includes('returned to inventory')) returned += 1;
        else if (n.includes('-> shipped')) shipped += 1;
        else if (n.includes('-> sold')) sold += 1;
      }
    }

    // Avg intake→first-audit, over assets audited in the range. Needs each
    // asset's created + earliest audit events across all time.
    const firstCreated = new Map<string, number>();
    const firstAudit = new Map<string, number>();
    for (const e of events) {
      const t = new Date(e.createdAt).getTime();
      if (e.eventType === 'created') {
        const cur = firstCreated.get(e.assetId);
        if (cur == null || t < cur) firstCreated.set(e.assetId, t);
      } else if (e.eventType === 'audited') {
        const cur = firstAudit.get(e.assetId);
        if (cur == null || t < cur) firstAudit.set(e.assetId, t);
      }
    }
    const spans: number[] = [];
    for (const id of auditedAssets) {
      const c = firstCreated.get(id);
      const a = firstAudit.get(id);
      if (c != null && a != null && a >= c) spans.push((a - c) / 86_400_000);
    }
    const avgProcessingDays =
      spans.length > 0 ? round2(spans.reduce((s, d) => s + d, 0) / spans.length) : null;

    // Daily throughput pulse over the effective window (range, or last 30 days).
    const dayEnd = to ?? new Date();
    const dayStart = from ?? new Date(dayEnd.getTime() - 29 * 86_400_000);
    const dayKey = (t: number) => {
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const days: string[] = [];
    for (let t = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate()).getTime(); t <= dayEnd.getTime(); t += 86_400_000) {
      days.push(dayKey(t));
    }
    const dayAgg = new Map(days.map((d) => [d, 0]));
    const isThroughput = (e: AssetHistory) =>
      e.eventType === 'created' ||
      e.eventType === 'scanned' ||
      e.eventType === 'audited' ||
      (e.eventType === 'status_changed' &&
        (notes(e).includes('-> sold') || notes(e).includes('-> shipped') || notes(e).includes('returned to inventory')));
    for (const e of events) {
      if (!isThroughput(e)) continue;
      const key = dayKey(new Date(e.createdAt).getTime());
      if (dayAgg.has(key)) dayAgg.set(key, dayAgg.get(key)! + 1);
    }
    const daily = days.map((d) => ({ date: d, count: dayAgg.get(d)! }));

    const windowLabel =
      from || to
        ? 'selected range'
        : 'last 30 days';

    return {
      metrics: { received, scanned, audited, shipped, sold, returned },
      processedAssets: auditedAssets.size,
      avgProcessingDays,
      daily,
      windowLabel,
    };
  }

  async getBatchAnalytics(from?: Date, to?: Date, user?: RequestUser): Promise<BatchAnalytics[]> {
    let [batches, assets, lots] = await Promise.all([
      this.batches.find({ relations: ['owner', 'createdBy'], order: { createdAt: 'DESC' } }),
      this.assets
        .createQueryBuilder('a')
        .select([
          'a.id', 'a.batchId', 'a.lotId', 'a.conditionGrade', 'a.auditStatus',
          'a.purchaseCost', 'a.salePrice', 'a.stockStatus', 'a.soldAt',
        ])
        .getMany(),
      this.lots.find(),
    ]);

    const owned = await this.ownedBatchIds(user);
    if (owned) {
      batches = batches.filter((b) => owned.has(b.id));
      assets = assets.filter((a) => a.batchId != null && owned.has(a.batchId));
      lots = lots.filter((l) => l.batchId != null && owned.has(l.batchId));
    }

    const batchById = new Map(batches.map((b) => [b.id, b]));
    const unitsPerBatch = new Map<string, number>();
    for (const a of assets) if (a.batchId) unitsPerBatch.set(a.batchId, (unitsPerBatch.get(a.batchId) ?? 0) + 1);
    const allocated = (a: Asset): number => {
      if (a.purchaseCost != null) return a.purchaseCost;
      const b = a.batchId ? batchById.get(a.batchId) : undefined;
      const u = a.batchId ? unitsPerBatch.get(a.batchId) ?? 0 : 0;
      return b?.totalCost != null && u > 0 ? b.totalCost / u : 0;
    };
    const inRange = (d: Date | string | null | undefined): boolean => {
      if (!d) return false;
      const t = new Date(d).getTime();
      if (from && t < from.getTime()) return false;
      if (to && t > to.getTime()) return false;
      return true;
    };

    const assetsByBatch = new Map<string, Asset[]>();
    for (const a of assets) {
      if (!a.batchId) continue;
      const arr = assetsByBatch.get(a.batchId) ?? [];
      arr.push(a);
      assetsByBatch.set(a.batchId, arr);
    }
    const lotsByBatch = new Map<string, Lot[]>();
    for (const l of lots) {
      if (!l.batchId) continue;
      const arr = lotsByBatch.get(l.batchId) ?? [];
      arr.push(l);
      lotsByBatch.set(l.batchId, arr);
    }

    // Roll a set of assets up into the sub-lot's stats.
    const summarise = (items: Asset[]) => {
      const sold = items.filter((a) => a.stockStatus === AssetStockStatus.SOLD && inRange(a.soldAt));
      let points = 0;
      let graded = 0;
      let audited = 0;
      for (const a of items) {
        const p = a.conditionGrade ? GRADE_POINTS[a.conditionGrade] : undefined;
        if (p != null) {
          points += p;
          graded += 1;
        }
        if (a.auditStatus != null) audited += 1;
      }
      return {
        assets: items.length,
        sold: sold.length,
        cost: round2(items.reduce((s, a) => s + allocated(a), 0)),
        revenue: round2(sold.reduce((s, a) => s + (a.salePrice ?? 0), 0)),
        avgGrade: graded > 0 ? gradeLetter(points / graded) : null,
        completionPct: items.length > 0 ? round2((audited / items.length) * 100) : 0,
      };
    };

    return batches.map((b) => {
      const bAssets = assetsByBatch.get(b.id) ?? [];
      const bLots = (lotsByBatch.get(b.id) ?? []).sort((x, y) => x.lotNumber.localeCompare(y.lotNumber));
      const soldInRange = bAssets.filter((a) => a.stockStatus === AssetStockStatus.SOLD && inRange(a.soldAt));
      const revenue = round2(soldInRange.reduce((s, a) => s + (a.salePrice ?? 0), 0));
      const cost = round2(soldInRange.reduce((s, a) => s + allocated(a), 0));
      const profit = round2(revenue - cost);

      const subLots: BatchAnalytics['subLots'] = bLots.map((l) => {
        const lAssets = bAssets.filter((a) => a.lotId === l.id);
        return {
          lotId: l.id as string | null,
          lotNumber: l.lotNumber,
          description: l.description,
          ...summarise(lAssets),
        };
      });
      // Assets sitting directly in the batch (no sub-lot) as a synthetic group.
      const direct = bAssets.filter((a) => a.lotId == null);
      if (direct.length > 0) {
        subLots.push({
          lotId: null,
          lotNumber: 'No sub-lot',
          description: null,
          ...summarise(direct),
        });
      }

      return {
        batchId: b.id,
        batchNumber: b.batchNumber,
        owner: b.owner?.name ?? null,
        createdBy: b.createdBy?.name ?? null,
        source: b.source,
        createdAt: (b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt)).toISOString(),
        status: b.status,
        totalSubLots: bLots.length,
        totalAssets: bAssets.length,
        unitsSold: soldInRange.length,
        totalCost: b.totalCost,
        revenue,
        profit,
        marginPct: revenue > 0 ? round2((profit / revenue) * 100) : null,
        subLots,
      };
    });
  }

  async getSalesAnalytics(from?: Date, to?: Date, user?: RequestUser): Promise<SalesAnalytics> {
    let [assets, batches, palletSold] = await Promise.all([
      this.assets
        .createQueryBuilder('a')
        .select([
          'a.id', 'a.batchId', 'a.category', 'a.manufacturer', 'a.model',
          'a.purchaseCost', 'a.salePrice', 'a.stockStatus', 'a.soldAt',
        ])
        .where('a.stock_status = :sold', { sold: AssetStockStatus.SOLD })
        .getMany(),
      this.batches.find(),
      this.palletSold.find({ where: { returnedAt: IsNull() }, relations: { product: true } }),
    ]);

    const owned = await this.ownedBatchIds(user);
    if (owned) {
      // Device sales scope to owned lots; pallet goods stay global (shared).
      assets = assets.filter((a) => a.batchId != null && owned.has(a.batchId));
    }

    // Allocated per-unit cost for a sold device (override ?? even lot split).
    const unitsPerBatch = new Map<string, number>();
    for (const a of assets) if (a.batchId) unitsPerBatch.set(a.batchId, (unitsPerBatch.get(a.batchId) ?? 0) + 1);
    const batchById = new Map(batches.map((b) => [b.id, b]));
    const allocated = (a: Asset): number => {
      if (a.purchaseCost != null) return a.purchaseCost;
      const b = a.batchId ? batchById.get(a.batchId) : undefined;
      const u = a.batchId ? unitsPerBatch.get(a.batchId) ?? 0 : 0;
      return b?.totalCost != null && u > 0 ? b.totalCost / u : 0;
    };

    const inRange = (d: Date | string | null | undefined): boolean => {
      if (!d) return false;
      const t = new Date(d).getTime();
      if (from && t < from.getTime()) return false;
      if (to && t > to.getTime()) return false;
      return true;
    };

    // Unified sale events across both sources.
    type Sale = {
      soldAt: Date; units: number; revenue: number; cost: number; priced: boolean;
      manufacturer: string; model: string; category: string; supplier: string | null;
    };
    const sales: Sale[] = [];
    for (const a of assets) {
      if (!a.soldAt) continue;
      sales.push({
        soldAt: new Date(a.soldAt),
        units: 1,
        revenue: a.salePrice ?? 0,
        cost: allocated(a),
        priced: a.salePrice != null,
        manufacturer: a.manufacturer?.trim() || 'Unknown',
        model: a.model?.trim() || 'Unknown',
        category: a.category?.trim() || 'Uncategorised',
        supplier: (a.batchId ? batchById.get(a.batchId)?.source : null) ?? null,
      });
    }
    for (const r of palletSold) {
      sales.push({
        soldAt: new Date(r.soldAt),
        units: r.quantity,
        revenue: r.saleTotal ?? 0,
        cost: r.unitCost != null ? r.unitCost * r.quantity : 0,
        priced: r.saleTotal != null,
        manufacturer: r.product?.manufacturer?.trim() || 'Pallet goods',
        model: r.product?.model?.trim() || r.variant,
        category: r.product?.category?.trim() || 'Pallet goods',
        supplier: null, // pallet goods aren't attributed to a supplier
      });
    }

    const ranged = sales.filter((s) => inRange(s.soldAt));

    // Summary over the range.
    let soldUnits = 0, revenue = 0, cost = 0, pricedRevenue = 0, pricedUnits = 0;
    for (const s of ranged) {
      soldUnits += s.units;
      revenue += s.revenue;
      cost += s.cost;
      if (s.priced) {
        pricedRevenue += s.revenue;
        pricedUnits += s.units;
      }
    }
    const profit = revenue - cost;

    // Fixed windows for the two headline "sold" counts.
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const soldToday = sales.filter((s) => s.soldAt.getTime() >= startToday).reduce((n, s) => n + s.units, 0);
    const soldThisMonth = sales.filter((s) => s.soldAt.getTime() >= startMonth).reduce((n, s) => n + s.units, 0);

    // Rolling 12 months (trend context, independent of the range).
    const months: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const monthAgg = new Map(months.map((m) => [m, { revenue: 0, profit: 0, units: 0 }]));
    for (const s of sales) {
      const key = `${s.soldAt.getFullYear()}-${String(s.soldAt.getMonth() + 1).padStart(2, '0')}`;
      const bucket = monthAgg.get(key);
      if (bucket) {
        bucket.revenue += s.revenue;
        bucket.profit += s.revenue - s.cost;
        bucket.units += s.units;
      }
    }
    const monthly = months.map((m) => ({
      month: m,
      revenue: round2(monthAgg.get(m)!.revenue),
      profit: round2(monthAgg.get(m)!.profit),
      units: monthAgg.get(m)!.units,
    }));

    // Top lists (over the range) — units + revenue.
    const topBy = (key: (s: Sale) => string, limit: number) => {
      const m = new Map<string, { units: number; revenue: number }>();
      for (const s of ranged) {
        const e = m.get(key(s)) ?? { units: 0, revenue: 0 };
        e.units += s.units;
        e.revenue += s.revenue;
        m.set(key(s), e);
      }
      return [...m.entries()]
        .map(([label, e]) => ({ label, units: e.units, revenue: round2(e.revenue) }))
        .sort((x, y) => y.units - x.units)
        .slice(0, limit);
    };

    // Profit by supplier (device sales only — pallet goods have no supplier link).
    const supMap = new Map<string, { units: number; revenue: number; cost: number }>();
    for (const s of ranged) {
      if (!s.supplier) continue;
      const e = supMap.get(s.supplier) ?? { units: 0, revenue: 0, cost: 0 };
      e.units += s.units;
      e.revenue += s.revenue;
      e.cost += s.cost;
      supMap.set(s.supplier, e);
    }
    const bySupplier = [...supMap.entries()]
      .map(([label, e]) => {
        const p = e.revenue - e.cost;
        return {
          label,
          units: e.units,
          revenue: round2(e.revenue),
          cost: round2(e.cost),
          profit: round2(p),
          marginPct: e.revenue > 0 ? round2((p / e.revenue) * 100) : null,
        };
      })
      .sort((x, y) => y.revenue - x.revenue);

    return {
      summary: {
        soldUnits,
        revenue: round2(revenue),
        cost: round2(cost),
        profit: round2(profit),
        marginPct: revenue > 0 ? round2((profit / revenue) * 100) : null,
        avgSellPrice: pricedUnits > 0 ? round2(pricedRevenue / pricedUnits) : null,
        soldToday,
        soldThisMonth,
      },
      monthly,
      topManufacturers: topBy((s) => s.manufacturer, 8),
      topModels: topBy((s) => s.model, 8),
      topCategories: topBy((s) => s.category, 8),
      bySupplier,
    };
  }

  async getDashboard(user?: RequestUser): Promise<DashboardSummary> {
    // eslint-disable-next-line prefer-const
    let [assets, batches, lines, repairs, stock] = await Promise.all([
      this.assets
        .createQueryBuilder('a')
        .select(['a.id', 'a.batchId', 'a.purchaseCost', 'a.stockStatus', 'a.conditionGrade', 'a.createdAt'])
        .getMany(),
      this.batches.find(),
      this.lines.find(),
      this.repairLogs.find(),
      this.stockLines.find({ select: { id: true, quantity: true } }),
    ]);

    // Managers: restrict device/lot/repair metrics to their own lots. Sales
    // (lines) and consumables (stock) stay global — they're shared modules.
    const owned = await this.ownedBatchIds(user);
    if (owned) {
      batches = batches.filter((b) => owned.has(b.id));
      assets = assets.filter((a) => a.batchId != null && owned.has(a.batchId));
      const assetIds = new Set(assets.map((a) => a.id));
      repairs = repairs.filter((r) => assetIds.has(r.assetId));
    }

    const unitsPerBatch = new Map<string, number>();
    for (const a of assets) {
      if (a.batchId) unitsPerBatch.set(a.batchId, (unitsPerBatch.get(a.batchId) ?? 0) + 1);
    }
    const batchTotalCost = new Map(batches.map((b) => [b.id, b.totalCost]));

    const saleByAsset = new Map<string, number>();
    for (const l of lines) {
      if (!l.assetId) continue;
      saleByAsset.set(l.assetId, (saleByAsset.get(l.assetId) ?? 0) + (l.unitPrice ?? 0) * l.quantity);
    }

    const repairCostByAsset = new Map<string, number>();
    let rPending = 0;
    let rInProgress = 0;
    let rCompleted = 0;
    let rSpend = 0;
    for (const r of repairs) {
      if (r.status === 'pending') rPending += 1;
      else if (r.status === 'in_progress') rInProgress += 1;
      else if (r.status === 'completed') {
        rCompleted += 1;
        rSpend += r.cost ?? 0;
        repairCostByAsset.set(r.assetId, (repairCostByAsset.get(r.assetId) ?? 0) + (r.cost ?? 0));
      }
    }

    const allocated = (a: Asset): number => {
      if (a.purchaseCost != null) return a.purchaseCost;
      if (a.batchId) {
        const tc = batchTotalCost.get(a.batchId);
        const u = unitsPerBatch.get(a.batchId) ?? 0;
        if (tc != null && u > 0) return tc / u;
      }
      return 0;
    };

    const byStatus: Record<string, number> = {};
    const byGrade: Record<string, number> = {};
    const ageing: Record<string, number> = {
      '0–30 days': 0,
      '31–60 days': 0,
      '61–90 days': 0,
      '90+ days': 0,
    };
    let sold = 0;
    let disposed = 0;
    let stockAtCost = 0;
    let revenue = 0;
    let costOfSold = 0;
    let repairsOfSold = 0;
    const now = Date.now();

    for (const a of assets) {
      byStatus[a.stockStatus] = (byStatus[a.stockStatus] ?? 0) + 1;
      const g = a.conditionGrade ?? 'ungraded';
      byGrade[g] = (byGrade[g] ?? 0) + 1;

      if (a.stockStatus === AssetStockStatus.SHIPPED) {
        sold += 1;
        revenue += saleByAsset.get(a.id) ?? 0;
        costOfSold += allocated(a);
        repairsOfSold += repairCostByAsset.get(a.id) ?? 0;
      } else if (a.stockStatus === AssetStockStatus.DISPOSED) {
        disposed += 1;
      } else {
        stockAtCost += allocated(a);
        const days = (now - new Date(a.createdAt).getTime()) / 86_400_000;
        if (days <= 30) ageing['0–30 days'] += 1;
        else if (days <= 60) ageing['31–60 days'] += 1;
        else if (days <= 90) ageing['61–90 days'] += 1;
        else ageing['90+ days'] += 1;
      }
    }

    const total = assets.length;
    const inStock = total - sold - disposed;
    const denom = sold + inStock;

    return {
      totalDevices: total,
      inStock,
      sold,
      sellThroughPct: denom > 0 ? round2((sold / denom) * 100) : null,
      revenue: round2(revenue),
      realizedProfit: round2(revenue - costOfSold - repairsOfSold),
      stockAtCost: round2(stockAtCost),
      byStatus: Object.entries(byStatus)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count),
      byGrade: Object.entries(byGrade)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count),
      ageing: Object.entries(ageing).map(([key, count]) => ({ key, count })),
      repairs: { pending: rPending, inProgress: rInProgress, completed: rCompleted, spend: round2(rSpend) },
      lots: {
        total: batches.length,
        reconciled: batches.filter((b) => b.status === 'reconciled').length,
      },
      consumables: {
        total: stock.length,
        lowStock: stock.filter((s) => stockStatusFor(s.quantity) === 'low_stock').length,
        outOfStock: stock.filter((s) => stockStatusFor(s.quantity) === 'out_of_stock').length,
      },
    };
  }

  async getNotifications(user?: RequestUser): Promise<Notification[]> {
    let [assets, stock] = await Promise.all([
      this.assets.find({ relations: ['location'] }),
      this.stockLines.find(),
    ]);
    const owned = await this.ownedBatchIds(user);
    if (owned) assets = assets.filter((a) => a.batchId != null && owned.has(a.batchId));
    // stock (consumables) stays global — shared module.
    const notifications: Notification[] = [];

    for (const asset of assets) {
      if (asset.stockStatus === AssetStockStatus.QUARANTINED) {
        notifications.push({
          id: `${asset.id}:quarantined`,
          type: 'quarantined',
          severity: 'warning',
          message: `${asset.name} (${asset.tag}) is quarantined/on hold`,
          href: `/assets/${asset.id}`,
        });
      }

      if (asset.auditStatus === AssetAuditStatus.REPAIR_REQUIRED) {
        notifications.push({
          id: `${asset.id}:repair_required`,
          type: 'repair_required',
          severity: 'warning',
          message: `${asset.name} (${asset.tag}) needs repair`,
          href: `/assets/${asset.id}`,
        });
      }

      if (asset.auditStatus === AssetAuditStatus.BEYOND_ECONOMIC_REPAIR) {
        notifications.push({
          id: `${asset.id}:ber`,
          type: 'ber',
          severity: 'critical',
          message: `${asset.name} (${asset.tag}) is beyond economic repair`,
          href: `/assets/${asset.id}`,
        });
      }
    }

    // Consumables running low or out — the operational alert that replaces warranty.
    for (const line of stock) {
      const status = stockStatusFor(line.quantity);
      if (status === 'out_of_stock') {
        notifications.push({
          id: `${line.id}:out_of_stock`,
          type: 'out_of_stock',
          severity: 'critical',
          message: `${line.name} is out of stock`,
          href: `/stock/${line.id}`,
        });
      } else if (status === 'low_stock') {
        notifications.push({
          id: `${line.id}:low_stock`,
          type: 'low_stock',
          severity: 'warning',
          message: `${line.name} is low on stock (${line.quantity} left)`,
          href: `/stock/${line.id}`,
        });
      }
    }

    return notifications;
  }

  async exportAssetsCsv(user?: RequestUser): Promise<string> {
    let assets = await this.assets.find({ relations: ['location', 'owner'] });
    const owned = await this.ownedBatchIds(user);
    if (owned) assets = assets.filter((a) => a.batchId != null && owned.has(a.batchId));

    const header = [
      'tag',
      'name',
      'category',
      'stock_status',
      'condition_grade',
      'audit_status',
      'location',
      'owner',
      'updated_at',
    ];
    const rows = assets.map((a) =>
      [
        a.tag,
        a.name,
        a.category,
        a.stockStatus,
        a.conditionGrade ?? '',
        a.auditStatus ?? '',
        a.location?.name ?? '',
        a.owner?.name ?? '',
        a.updatedAt.toISOString(),
      ]
        .map(csvEscape)
        .join(','),
    );

    return [header.join(','), ...rows].join('\n');
  }
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
