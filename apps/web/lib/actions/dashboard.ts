// Mirror of apps/api/src/dashboard/dashboard.types.ts. The API deliberately
// returns keys, not URLs — the routes belong to this app, and a link built on
// the server would rot the moment a page moved. ATTENTION_LINKS below is that
// mapping, and it is the one place to change when a route changes.

export interface AttentionRow {
  key:
    | 'out_of_stock'
    | 'low_stock'
    | 'discrepancies'
    | 'no_location'
    | 'never_audited'
    | 'quarantined'
    | 'overdue_incoming';
  label: string;
  count: number;
  severity: 'critical' | 'warning';
  detail: string;
}

export interface LocationRow {
  id: string | null;
  name: string;
  devices: number;
  value: number | null;
  consumableLines: number;
  lowStockLines: number;
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
  generatedAt: string;
  metrics: {
    totalInventory: number;
    inStock: number;
    committed: number;
    sold: number;
    consumableLines: number;
    consumableUnits: number;
    lowStockLines: number;
    outOfStockLines: number;
    pendingActions: number;
  };
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
  slowMoving: { thresholdDays: number; count: number; value: number | null };
  incoming: {
    expectedToday: number;
    expectedThisWeek: number;
    overdue: number;
    awaitingReceiptLots: number;
    awaitingReceiptUnits: number;
    noDatePromised: number;
  };
  movement: { devices: MovementRow[]; consumables: MovementRow[] };
  health: { status: 'good' | 'needs_attention' | 'critical'; conditions: HealthCondition[] };
  activity: ActivityRow[];
}

// Where each attention row sends you. Every one of these lands on a list that
// is already filtered to exactly the devices or lines being counted — the point
// of the section is that nobody has to go and search for them.
export const ATTENTION_LINKS: Record<AttentionRow['key'], { href: string; action: string }> = {
  out_of_stock: { href: '/stock?status=out_of_stock', action: 'View' },
  low_stock: { href: '/stock?status=low_stock', action: 'View' },
  discrepancies: { href: '/batches?filter=discrepancy', action: 'Review' },
  no_location: { href: '/assets?noLocation=true', action: 'View' },
  never_audited: { href: '/assets?noAudit=true', action: 'View' },
  quarantined: { href: '/assets?stockStatus=quarantined', action: 'View' },
  overdue_incoming: { href: '/batches?filter=overdue', action: 'Review' },
};
