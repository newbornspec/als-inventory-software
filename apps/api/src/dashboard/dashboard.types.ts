// The operational dashboard payload.
//
// Two rules shape everything in here:
//
//  1. No invented numbers. Every figure below comes from a column that already
//     exists (or, for expectedArrivalDate, one added deliberately for it). Where
//     the spec asked for something the warehouse does not record — a stocktake
//     session, stock transfers, a write-off date before today — the field is
//     absent rather than filled with a plausible-looking proxy.
//
//  2. No hrefs from the API. The server returns a stable `key` per row; the web
//     app owns the mapping from key to route, because the routes are the web
//     app's business and a link built here would rot silently.

// One row of ATTENTION REQUIRED. `count` is always the number of underlying
// records, so it matches the length of the list its link lands on.
export interface AttentionRow {
  key:
    | 'out_of_stock'
    | 'low_stock'
    | 'pending_repairs'
    | 'discrepancies'
    | 'no_location'
    | 'never_audited'
    | 'quarantined'
    | 'overdue_incoming';
  label: string;
  count: number;
  // critical = something is already broken; warning = it will break soon.
  severity: 'critical' | 'warning';
  // Plain-language definition, shown in the UI so the number explains itself
  // (e.g. "below 10 on hand" — the threshold is not guessable from the count).
  detail: string;
}

export interface LocationRow {
  // null id = the "No location set" bucket, which is itself an attention item.
  id: string | null;
  name: string;
  devices: number;
  // Allocated purchase cost of those devices. null for callers who may not see
  // money, never 0 — 0 is a real value and must not be confused with "hidden".
  value: number | null;
  consumableLines: number;
  lowStockLines: number;
  openRepairs: number;
}

export interface AgeingBucket {
  key: string;
  count: number;
  value: number | null;
}

export interface MovementRow {
  key: string;
  label: string;
  last7: number;
  last30: number;
}

export interface HealthCondition {
  key: string;
  label: string;
  count: number;
  ok: boolean;
  severity: 'critical' | 'warning';
}

export interface ActivityRow {
  id: string;
  summary: string;
  user: string | null;
  at: string;
}

export interface OperationsDashboard {
  // When the server computed this, so the page can say "Last updated …" without
  // guessing. ISO 8601, UTC.
  generatedAt: string;

  metrics: {
    // Everything still held: excludes sold, disposed and shipped.
    totalInventory: number;
    // Physically on the shelf and uncommitted.
    inStock: number;
    // Allocated / picked / packed — spoken for, still on site.
    committed: number;
    sold: number;
    consumableLines: number;
    consumableUnits: number;
    lowStockLines: number;
    outOfStockLines: number;
    pendingRepairs: number;
    // The sum of every ATTENTION REQUIRED count — a queue length, not a score.
    pendingActions: number;
  };

  // Money is admin/manager only. null (not zero, not omitted) for technicians so
  // the client can tell "not permitted" from "nothing there".
  finance: {
    stockValue: number;
    revenue: number;
    realizedProfit: number;
    sellThroughPct: number | null;
  } | null;

  attention: AttentionRow[];
  locations: LocationRow[];
  byStatus: { key: string; count: number }[];
  ageing: AgeingBucket[];

  // Deliberately "in stock longer than N days" and labelled as such. The
  // warehouse has no per-asset last-movement timestamp, so a claim of "no
  // movement in N days" would be unfounded.
  slowMoving: { thresholdDays: number; count: number; value: number | null };

  incoming: {
    expectedToday: number;
    expectedThisWeek: number;
    overdue: number;
    awaitingReceiptLots: number;
    awaitingReceiptUnits: number;
    // Lots with no promised date: awaiting receipt, but never overdue.
    noDatePromised: number;
  };

  movement: {
    devices: MovementRow[];
    consumables: MovementRow[];
  };

  health: {
    status: 'good' | 'needs_attention' | 'critical';
    conditions: HealthCondition[];
  };

  activity: ActivityRow[];
}
