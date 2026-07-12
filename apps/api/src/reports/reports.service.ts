import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset, AssetAuditStatus, AssetStockStatus } from '../assets/asset.entity';
import { Batch } from '../batches/batch.entity';
import { OrderLine } from '../sales/order-line.entity';

export interface Notification {
  id: string;
  type: 'warranty_expired' | 'warranty_expiring' | 'quarantined' | 'repair_required' | 'ber';
  severity: 'critical' | 'warning';
  assetId: string;
  assetTag: string;
  assetName: string;
  message: string;
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
  salePrice: number | null; // from the order line, if on one
  sold: boolean;
  profit: number | null; // salePrice - allocatedCost, when sold and both known
  orderId: string | null;
  orderNumber: string | null;
}

const WARRANTY_LOOKAHEAD_DAYS = 30;

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
    @InjectRepository(OrderLine) private lines: Repository<OrderLine>,
  ) {}

  // Profit per purchase lot (D6). Per-unit cost = the asset's manual override if
  // set, else an even split of the lot's total_cost across the lot's units.
  async getLotProfitability(): Promise<LotProfit[]> {
    const [batches, assets, lines] = await Promise.all([
      this.batches.find({ order: { createdAt: 'DESC' } }),
      this.assets.find(),
      this.lines.find(),
    ]);

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
      const sold = units.filter((a) => a.stockStatus === AssetStockStatus.SHIPPED);
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

  async getAssetCosting(assetId: string): Promise<AssetCosting> {
    const asset = await this.assets.findOne({ where: { id: assetId } });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);

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

    const line = await this.lines.findOne({ where: { assetId }, relations: ['order'] });
    const salePrice = line ? (line.unitPrice ?? 0) * line.quantity : null;
    const sold = asset.stockStatus === AssetStockStatus.SHIPPED;
    const profit =
      sold && salePrice != null && allocatedCost != null
        ? round2(salePrice - allocatedCost)
        : null;

    return {
      assetId,
      purchaseCost: asset.purchaseCost ?? null,
      lotTotalCost,
      unitsInLot,
      evenSplit,
      allocatedCost,
      salePrice,
      sold,
      profit,
      orderId: line?.order?.id ?? null,
      orderNumber: line?.order?.orderNumber ?? null,
    };
  }

  async exportProfitCsv(): Promise<string> {
    const rows = await this.getLotProfitability();
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

  async getNotifications(): Promise<Notification[]> {
    const assets = await this.assets.find({ relations: ['location'] });
    const now = new Date();
    const lookahead = new Date(now.getTime() + WARRANTY_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
    const notifications: Notification[] = [];

    for (const asset of assets) {
      if (asset.stockStatus === AssetStockStatus.QUARANTINED) {
        notifications.push({
          id: `${asset.id}:quarantined`,
          type: 'quarantined',
          severity: 'warning',
          assetId: asset.id,
          assetTag: asset.tag,
          assetName: asset.name,
          message: `${asset.name} (${asset.tag}) is quarantined/on hold`,
        });
      }

      if (asset.auditStatus === AssetAuditStatus.REPAIR_REQUIRED) {
        notifications.push({
          id: `${asset.id}:repair_required`,
          type: 'repair_required',
          severity: 'warning',
          assetId: asset.id,
          assetTag: asset.tag,
          assetName: asset.name,
          message: `${asset.name} (${asset.tag}) needs repair`,
        });
      }

      if (asset.auditStatus === AssetAuditStatus.BEYOND_ECONOMIC_REPAIR) {
        notifications.push({
          id: `${asset.id}:ber`,
          type: 'ber',
          severity: 'critical',
          assetId: asset.id,
          assetTag: asset.tag,
          assetName: asset.name,
          message: `${asset.name} (${asset.tag}) is beyond economic repair`,
        });
      }

      if (asset.warrantyExpiresAt) {
        const expiresAt = new Date(asset.warrantyExpiresAt);
        if (expiresAt < now) {
          notifications.push({
            id: `${asset.id}:warranty_expired`,
            type: 'warranty_expired',
            severity: 'critical',
            assetId: asset.id,
            assetTag: asset.tag,
            assetName: asset.name,
            message: `${asset.name} (${asset.tag}) warranty expired on ${asset.warrantyExpiresAt}`,
          });
        } else if (expiresAt <= lookahead) {
          notifications.push({
            id: `${asset.id}:warranty_expiring`,
            type: 'warranty_expiring',
            severity: 'warning',
            assetId: asset.id,
            assetTag: asset.tag,
            assetName: asset.name,
            message: `${asset.name} (${asset.tag}) warranty expires on ${asset.warrantyExpiresAt}`,
          });
        }
      }
    }

    return notifications;
  }

  async exportAssetsCsv(): Promise<string> {
    const assets = await this.assets.find({ relations: ['location', 'owner'] });

    const header = [
      'tag',
      'name',
      'category',
      'stock_status',
      'condition_grade',
      'audit_status',
      'location',
      'owner',
      'warranty_expires_at',
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
        a.warrantyExpiresAt ?? '',
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
