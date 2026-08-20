import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { LOW_STOCK_THRESHOLD } from '../stock/stock.service';
import { UserRole } from '../users/user.entity';
import { isScopedManager, type RequestUser } from '../common/ownership';
import type {
  ActivityRow,
  AgeingBucket,
  AttentionRow,
  HealthCondition,
  LocationRow,
  MovementRow,
  OperationsDashboard,
} from './dashboard.types';

// --- Status vocabulary -------------------------------------------------------
// The codebase had five different, mutually inconsistent answers to "is this
// device still ours?" (the old dashboard's version counted SOLD devices into
// stock value, because it only tested for SHIPPED). These three lists are the
// single definition this endpoint uses, and every query below refers to them by
// name rather than restating a status list inline.

// Gone: no longer inventory we hold.
const GONE = ['sold', 'shipped', 'disposed'] as const;
// On the shelf and free to allocate.
const AVAILABLE = ['in_stock', 'received', 'audited', 'awaiting_audit', 'returned'] as const;
// Spoken for but still on site.
const COMMITTED = ['allocated', 'picked', 'packed'] as const;

// Devices in stock this long are reported as slow-moving. 180 days is the point
// the ageing table's last bucket starts, so the two agree by construction.
const SLOW_MOVING_DAYS = 180;

// How many recent actions the dashboard's activity panel shows.
const ACTIVITY_ROWS = 8;

const sql = (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v);

// Per-unit cost basis, as SQL. Mirrors the rule used across the reports service:
// the unit's own purchase_cost when set, otherwise an even split of its lot's
// total_cost. The divisor is a COUNT over EVERY asset in the lot including sold
// ones — splitting a lot's cost across only the units still held would inflate
// the cost of whatever is left as the lot sells through.
const ALLOCATED_COST = sql`
  COALESCE(
    a.purchase_cost,
    CASE WHEN u.units > 0 THEN b.total_cost / u.units END,
    0
  )`;

const COST_JOINS = sql`
  LEFT JOIN batches b ON b.id = a.batch_id
  LEFT JOIN (
    SELECT batch_id, COUNT(*)::int AS units
    FROM assets
    WHERE batch_id IS NOT NULL
    GROUP BY batch_id
  ) u ON u.batch_id = a.batch_id`;

interface CountRow {
  count: string;
}

@Injectable()
export class DashboardService {
  constructor(@InjectRepository(Asset) private assets: Repository<Asset>) {}

  private q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return this.assets.query(text, params) as Promise<T[]>;
  }

  // A scoped manager sees only lots they own or unowned "pool" lots — and, as
  // everywhere else in the app, devices attached to no lot at all drop out of
  // their view entirely. Returned as a SQL fragment plus the parameter list, so
  // each query can splice it in with the right placeholder numbering.
  private scope(user: RequestUser | undefined, alias = 'a'): { clause: string; params: unknown[] } {
    if (!isScopedManager(user)) return { clause: '', params: [] };
    return {
      clause: sql`
        AND ${alias}.batch_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM batches sb
          WHERE sb.id = ${alias}.batch_id
            AND (sb.owner_id = $1::uuid OR sb.owner_id IS NULL)
        )`,
      params: [user!.userId],
    };
  }

  private batchScope(user: RequestUser | undefined, alias = 'b'): { clause: string; params: unknown[] } {
    if (!isScopedManager(user)) return { clause: '', params: [] };
    return {
      clause: sql` AND (${alias}.owner_id = $1::uuid OR ${alias}.owner_id IS NULL)`,
      params: [user!.userId],
    };
  }

  async getOperations(user?: RequestUser): Promise<OperationsDashboard> {
    const canSeeMoney = user?.role === UserRole.ADMIN || user?.role === UserRole.MANAGER;
    const s = this.scope(user);
    const bs = this.batchScope(user);

    const [
      byStatus,
      consumables,
      repairs,
      discrepancies,
      noLocation,
      neverAudited,
      locations,
      ageing,
      slowMoving,
      incoming,
      deviceMovement,
      consumableMovement,
      activity,
      finance,
    ] = await Promise.all([
      this.statusCounts(s),
      this.consumableSummary(),
      this.openRepairs(s),
      this.discrepancyCount(bs),
      this.noLocationCount(s),
      this.neverAuditedCount(s),
      this.locationRollup(s, canSeeMoney),
      this.ageingBuckets(s, canSeeMoney),
      this.slowMovingCount(s, canSeeMoney),
      this.incomingCounts(bs),
      this.deviceMovement(s),
      this.consumableMovement(),
      // The Activity page itself is admin/manager only, so the dashboard's
      // extract of it is gated the same way rather than quietly widening who
      // can see who did what.
      canSeeMoney ? this.recentActivity() : Promise.resolve([] as ActivityRow[]),
      canSeeMoney ? this.finance(s) : Promise.resolve(null),
    ]);

    const count = (keys: readonly string[]) =>
      byStatus.filter((r) => keys.includes(r.key)).reduce((n, r) => n + r.count, 0);

    const totalInventory = byStatus
      .filter((r) => !GONE.includes(r.key as (typeof GONE)[number]))
      .reduce((n, r) => n + r.count, 0);
    const quarantined = count(['quarantined']);

    const attention: AttentionRow[] = [
      {
        key: 'out_of_stock',
        label: 'Out of stock',
        count: consumables.outOfStockLines,
        severity: 'critical',
        detail: 'Consumable lines with nothing on hand',
      },
      {
        key: 'overdue_incoming',
        label: 'Overdue incoming',
        count: incoming.overdue,
        severity: 'critical',
        detail: 'Purchase lots past their expected arrival date',
      },
      {
        key: 'discrepancies',
        label: 'Stock discrepancies',
        count: discrepancies,
        severity: 'critical',
        detail: 'Lots where the scanned count differs from the manifest',
      },
      {
        key: 'low_stock',
        label: 'Low stock',
        count: consumables.lowStockLines,
        severity: 'warning',
        detail: `Consumable lines below ${LOW_STOCK_THRESHOLD} on hand`,
      },
      {
        key: 'pending_repairs',
        label: 'Open repairs',
        count: repairs,
        severity: 'warning',
        detail: 'Repair jobs logged but not finished',
      },
      {
        key: 'quarantined',
        label: 'Quarantined',
        count: quarantined,
        severity: 'warning',
        detail: 'Devices held and not available to sell',
      },
      {
        key: 'never_audited',
        label: 'Never audited',
        count: neverAudited,
        severity: 'warning',
        detail: 'Devices held with no audit result recorded',
      },
      {
        key: 'no_location',
        label: 'No location set',
        count: noLocation,
        severity: 'warning',
        detail: 'Devices held that are not assigned to a location',
      },
    ];

    const health = buildHealth(attention);

    return {
      generatedAt: new Date().toISOString(),
      metrics: {
        totalInventory,
        inStock: count(AVAILABLE),
        committed: count(COMMITTED),
        sold: count(['sold', 'shipped']),
        consumableLines: consumables.lines,
        consumableUnits: consumables.units,
        lowStockLines: consumables.lowStockLines,
        outOfStockLines: consumables.outOfStockLines,
        pendingRepairs: repairs,
        pendingActions: attention.reduce((n, r) => n + r.count, 0),
      },
      finance,
      attention,
      locations,
      byStatus,
      ageing,
      slowMoving: { thresholdDays: SLOW_MOVING_DAYS, ...slowMoving },
      incoming,
      movement: { devices: deviceMovement, consumables: consumableMovement },
      health,
      activity,
    };
  }

  // --- individual queries ----------------------------------------------------

  private async statusCounts(s: { clause: string; params: unknown[] }) {
    const rows = await this.q<{ key: string; count: string }>(
      sql`
        SELECT a.stock_status AS key, COUNT(*) AS count
        FROM assets a
        WHERE TRUE ${s.clause}
        GROUP BY a.stock_status
        ORDER BY COUNT(*) DESC`,
      s.params,
    );
    return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
  }

  // Consumables are a shared module — never scoped to a manager's lots, because
  // a box of cables belongs to the warehouse, not to a purchase lot.
  private async consumableSummary() {
    const [row] = await this.q<{
      lines: string;
      units: string;
      low: string;
      out: string;
    }>(
      sql`
        SELECT COUNT(*) AS lines,
               COALESCE(SUM(quantity), 0) AS units,
               COUNT(*) FILTER (WHERE quantity > 0 AND quantity < $1::int) AS low,
               COUNT(*) FILTER (WHERE quantity <= 0) AS out
        FROM stock_lines`,
      [LOW_STOCK_THRESHOLD],
    );
    return {
      lines: Number(row.lines),
      units: Number(row.units),
      lowStockLines: Number(row.low),
      outOfStockLines: Number(row.out),
    };
  }

  private async openRepairs(s: { clause: string; params: unknown[] }) {
    const [row] = await this.q<CountRow>(
      sql`
        SELECT COUNT(*) AS count
        FROM repair_logs r
        JOIN assets a ON a.id = r.asset_id
        WHERE r.status IN ('pending', 'in_progress') ${s.clause}`,
      s.params,
    );
    return Number(row.count);
  }

  // A discrepancy is arithmetic, not a status someone remembered to set: the
  // manifest count against the live count of devices actually scanned in.
  // Lots that never declared an expected count cannot disagree with anything.
  private async discrepancyCount(bs: { clause: string; params: unknown[] }) {
    const [row] = await this.q<CountRow>(
      sql`
        SELECT COUNT(*) AS count
        FROM batches b
        WHERE b.expected_unit_count IS NOT NULL
          AND b.status <> 'draft'
          AND b.expected_unit_count <> (
            SELECT COUNT(*) FROM assets a WHERE a.batch_id = b.id
          )
          ${bs.clause}`,
      bs.params,
    );
    return Number(row.count);
  }

  private async noLocationCount(s: { clause: string; params: unknown[] }) {
    const [row] = await this.q<CountRow>(
      sql`
        SELECT COUNT(*) AS count
        FROM assets a
        WHERE a.location_id IS NULL
          AND a.stock_status::text <> ALL($${s.params.length + 1}::text[])
          ${s.clause}`,
      [...s.params, GONE as unknown as string[]],
    );
    return Number(row.count);
  }

  private async neverAuditedCount(s: { clause: string; params: unknown[] }) {
    const [row] = await this.q<CountRow>(
      sql`
        SELECT COUNT(*) AS count
        FROM assets a
        WHERE a.audit_status IS NULL
          AND a.stock_status::text <> ALL($${s.params.length + 1}::text[])
          ${s.clause}`,
      [...s.params, GONE as unknown as string[]],
    );
    return Number(row.count);
  }

  // One row per location plus a "No location set" row, so a device can never
  // fall out of the roll-up without being visible somewhere.
  private async locationRollup(
    s: { clause: string; params: unknown[] },
    canSeeMoney: boolean,
  ): Promise<LocationRow[]> {
    const goneParam = `$${s.params.length + 1}::text[]`;
    const params = [...s.params, GONE as unknown as string[]];

    const devices = await this.q<{
      id: string | null;
      name: string | null;
      devices: string;
      value: string;
    }>(
      sql`
        SELECT a.location_id AS id,
               l.name AS name,
               COUNT(*) AS devices,
               COALESCE(SUM(${ALLOCATED_COST}), 0) AS value
        FROM assets a
        LEFT JOIN locations l ON l.id = a.location_id
        ${COST_JOINS}
        WHERE a.stock_status::text <> ALL(${goneParam}) ${s.clause}
        GROUP BY a.location_id, l.name`,
      params,
    );

    const repairs = await this.q<{ id: string | null; count: string }>(
      sql`
        SELECT a.location_id AS id, COUNT(*) AS count
        FROM repair_logs r
        JOIN assets a ON a.id = r.asset_id
        WHERE r.status IN ('pending', 'in_progress') ${s.clause}
        GROUP BY a.location_id`,
      s.params,
    );

    const stock = await this.q<{ id: string | null; lines: string; low: string }>(
      sql`
        SELECT location_id AS id,
               COUNT(*) AS lines,
               COUNT(*) FILTER (WHERE quantity > 0 AND quantity < $1::int) AS low
        FROM stock_lines
        GROUP BY location_id`,
      [LOW_STOCK_THRESHOLD],
    );

    const names = await this.q<{ id: string; name: string }>(
      sql`SELECT id, name FROM locations ORDER BY name`,
    );

    const key = (id: string | null) => id ?? '__none__';
    const rows = new Map<string, LocationRow>();
    const ensure = (id: string | null, name: string | null): LocationRow => {
      const k = key(id);
      let row = rows.get(k);
      if (!row) {
        row = {
          id,
          name: name ?? 'No location set',
          devices: 0,
          value: canSeeMoney ? 0 : null,
          consumableLines: 0,
          lowStockLines: 0,
          openRepairs: 0,
        };
        rows.set(k, row);
      }
      return row;
    };

    // Seed every known location so an empty warehouse still shows as a row —
    // "Warehouse B: 0 items" is information; a missing row is not.
    for (const l of names) ensure(l.id, l.name);
    for (const d of devices) {
      const row = ensure(d.id, d.name);
      row.devices = Number(d.devices);
      if (canSeeMoney) row.value = Number(d.value);
    }
    for (const r of repairs) ensure(r.id, null).openRepairs = Number(r.count);
    for (const st of stock) {
      const row = ensure(st.id, null);
      row.consumableLines = Number(st.lines);
      row.lowStockLines = Number(st.low);
    }

    return [...rows.values()].sort((x, y) => {
      // "No location set" last; otherwise biggest first, then by name.
      if (x.id === null) return 1;
      if (y.id === null) return -1;
      return y.devices - x.devices || x.name.localeCompare(y.name);
    });
  }

  // Age is measured from created_at — when the unit was booked in — because
  // that is the only arrival timestamp an asset carries.
  private async ageingBuckets(
    s: { clause: string; params: unknown[] },
    canSeeMoney: boolean,
  ): Promise<AgeingBucket[]> {
    const goneParam = `$${s.params.length + 1}::text[]`;
    const rows = await this.q<{ bucket: string; count: string; value: string }>(
      sql`
        SELECT CASE
                 WHEN age.days <= 30 THEN '0-30 days'
                 WHEN age.days <= 60 THEN '31-60 days'
                 WHEN age.days <= 90 THEN '61-90 days'
                 WHEN age.days <= 180 THEN '91-180 days'
                 ELSE '180+ days'
               END AS bucket,
               COUNT(*) AS count,
               COALESCE(SUM(${ALLOCATED_COST}), 0) AS value
        FROM assets a
        ${COST_JOINS}
        CROSS JOIN LATERAL (
          SELECT EXTRACT(EPOCH FROM (now() - a.created_at)) / 86400 AS days
        ) age
        WHERE a.stock_status::text <> ALL(${goneParam}) ${s.clause}
        GROUP BY bucket`,
      [...s.params, GONE as unknown as string[]],
    );

    const order = ['0-30 days', '31-60 days', '61-90 days', '91-180 days', '180+ days'];
    const found = new Map(rows.map((r) => [r.bucket, r]));
    return order.map((key) => {
      const r = found.get(key);
      return {
        key,
        count: r ? Number(r.count) : 0,
        value: canSeeMoney ? (r ? Number(r.value) : 0) : null,
      };
    });
  }

  private async slowMovingCount(
    s: { clause: string; params: unknown[] },
    canSeeMoney: boolean,
  ): Promise<{ count: number; value: number | null }> {
    const goneParam = `$${s.params.length + 1}::text[]`;
    const daysParam = `$${s.params.length + 2}::int`;
    const [row] = await this.q<{ count: string; value: string }>(
      sql`
        SELECT COUNT(*) AS count, COALESCE(SUM(${ALLOCATED_COST}), 0) AS value
        FROM assets a
        ${COST_JOINS}
        WHERE a.stock_status::text <> ALL(${goneParam})
          AND a.created_at < now() - (${daysParam} * interval '1 day')
          ${s.clause}`,
      [...s.params, GONE as unknown as string[], SLOW_MOVING_DAYS],
    );
    return { count: Number(row.count), value: canSeeMoney ? Number(row.value) : null };
  }

  // "Not here yet" is every status before the goods are physically being
  // handled. Once a lot is in receiving it has arrived, whatever its dates say.
  private async incomingCounts(bs: { clause: string; params: unknown[] }) {
    const [row] = await this.q<{
      today: string;
      week: string;
      overdue: string;
      lots: string;
      units: string;
      nodate: string;
    }>(
      sql`
        SELECT
          COUNT(*) FILTER (WHERE b.expected_arrival_date = CURRENT_DATE) AS today,
          COUNT(*) FILTER (
            WHERE b.expected_arrival_date >= CURRENT_DATE
              AND b.expected_arrival_date < CURRENT_DATE + 7
          ) AS week,
          COUNT(*) FILTER (WHERE b.expected_arrival_date < CURRENT_DATE) AS overdue,
          COUNT(*) AS lots,
          COALESCE(SUM(b.expected_unit_count), 0) AS units,
          COUNT(*) FILTER (WHERE b.expected_arrival_date IS NULL) AS nodate
        FROM batches b
        WHERE b.status IN ('draft', 'awaiting_arrival', 'open') ${bs.clause}`,
      bs.params,
    );
    return {
      expectedToday: Number(row.today),
      expectedThisWeek: Number(row.week),
      overdue: Number(row.overdue),
      awaitingReceiptLots: Number(row.lots),
      awaitingReceiptUnits: Number(row.units),
      noDatePromised: Number(row.nodate),
    };
  }

  // Only the event types the app actually writes. There is deliberately no
  // "adjusted" or "written off" row here: assets have no adjustment event, and
  // disposal records no date, so either row could only ever read a fixed zero —
  // which would claim those things are tracked and never happen.
  private async deviceMovement(s: { clause: string; params: unknown[] }): Promise<MovementRow[]> {
    const rows = await this.q<{ key: string; last7: string; last30: string }>(
      sql`
        SELECT h.event_type AS key,
               COUNT(*) FILTER (WHERE h.created_at >= now() - interval '7 days') AS last7,
               COUNT(*) FILTER (WHERE h.created_at >= now() - interval '30 days') AS last30
        FROM asset_history h
        JOIN assets a ON a.id = h.asset_id
        WHERE h.created_at >= now() - interval '30 days' ${s.clause}
        GROUP BY h.event_type`,
      s.params,
    );

    const LABELS: Record<string, string> = {
      created: 'Booked in',
      scanned: 'Scanned',
      transferred: 'Moved location',
      status_changed: 'Status changed',
      condition_changed: 'Regraded',
      audited: 'Audited',
      retired: 'Retired',
    };
    const found = new Map(rows.map((r) => [r.key, r]));
    return Object.keys(LABELS).map((key) => {
      const r = found.get(key);
      return {
        key,
        label: LABELS[key],
        last7: r ? Number(r.last7) : 0,
        last30: r ? Number(r.last30) : 0,
      };
    });
  }

  private async consumableMovement(): Promise<MovementRow[]> {
    const rows = await this.q<{ key: string; last7: string; last30: string }>(
      sql`
        SELECT reason AS key,
               COALESCE(SUM(ABS(delta)) FILTER (WHERE created_at >= now() - interval '7 days'), 0) AS last7,
               COALESCE(SUM(ABS(delta)) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS last30
        FROM stock_movements
        WHERE created_at >= now() - interval '30 days'
        GROUP BY reason`,
    );

    const LABELS: Record<string, string> = {
      received: 'Received',
      used: 'Used',
      adjusted: 'Adjusted',
      returned: 'Returned',
      scrapped: 'Written off',
    };
    const found = new Map(rows.map((r) => [r.key, r]));
    return Object.keys(LABELS).map((key) => {
      const r = found.get(key);
      return {
        key,
        label: LABELS[key],
        last7: r ? Number(r.last7) : 0,
        last30: r ? Number(r.last30) : 0,
      };
    });
  }

  private async recentActivity(): Promise<ActivityRow[]> {
    const rows = await this.q<{
      id: string;
      summary: string;
      name: string | null;
      created_at: Date;
    }>(
      sql`
        SELECT al.id, al.summary, u.name, al.created_at
        FROM activity_log al
        LEFT JOIN users u ON u.id = al.user_id
        ORDER BY al.created_at DESC
        LIMIT $1::int`,
      [ACTIVITY_ROWS],
    );
    return rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      user: r.name,
      at: new Date(r.created_at).toISOString(),
    }));
  }

  private async finance(s: { clause: string; params: unknown[] }) {
    const goneParam = `$${s.params.length + 1}::text[]`;
    const [row] = await this.q<{
      stock_value: string;
      revenue: string;
      cost_of_sold: string;
      sold: string;
      total: string;
    }>(
      sql`
        SELECT
          COALESCE(SUM(${ALLOCATED_COST}) FILTER (WHERE a.stock_status::text <> ALL(${goneParam})), 0) AS stock_value,
          COALESCE(SUM(a.sale_price) FILTER (WHERE a.stock_status IN ('sold', 'shipped')), 0) AS revenue,
          COALESCE(SUM(${ALLOCATED_COST}) FILTER (WHERE a.stock_status IN ('sold', 'shipped')), 0) AS cost_of_sold,
          COUNT(*) FILTER (WHERE a.stock_status IN ('sold', 'shipped')) AS sold,
          COUNT(*) AS total
        FROM assets a
        ${COST_JOINS}
        WHERE TRUE ${s.clause}`,
      [...s.params, GONE as unknown as string[]],
    );

    // Repair spend on units that have since sold is a real cost of that sale.
    const [rep] = await this.q<{ spend: string }>(
      sql`
        SELECT COALESCE(SUM(r.cost), 0) AS spend
        FROM repair_logs r
        JOIN assets a ON a.id = r.asset_id
        WHERE a.stock_status IN ('sold', 'shipped') ${s.clause}`,
      s.params,
    );

    const revenue = Number(row.revenue);
    const sold = Number(row.sold);
    const total = Number(row.total);
    return {
      stockValue: round2(Number(row.stock_value)),
      revenue: round2(revenue),
      realizedProfit: round2(revenue - Number(row.cost_of_sold) - Number(rep.spend)),
      sellThroughPct: total > 0 ? Math.round((sold / total) * 100) : null,
    };
  }
}

// Health is a list of named conditions, each one a real count with a real
// definition — not a blended score. The overall word is a straight roll-up of
// those conditions, so "NEEDS ATTENTION" can always be explained by pointing at
// the row that caused it.
function buildHealth(attention: AttentionRow[]): {
  status: 'good' | 'needs_attention' | 'critical';
  conditions: HealthCondition[];
} {
  const conditions: HealthCondition[] = attention.map((a) => ({
    key: a.key,
    label: a.label,
    count: a.count,
    ok: a.count === 0,
    severity: a.severity,
  }));
  const breached = conditions.filter((c) => !c.ok);
  const status = breached.some((c) => c.severity === 'critical')
    ? 'critical'
    : breached.length > 0
      ? 'needs_attention'
      : 'good';
  return { status, conditions };
}

// Money arrives from Postgres numeric as a string and is summed in JS floats;
// round once at the boundary so 0.1 + 0.2 never reaches the UI.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
