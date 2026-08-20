import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { money } from '@/lib/money';
import { formatLabel } from '@/lib/asset-options';
import { CategoryDonut, CountBars, DailyBars, MonthlyTrend, type DayPoint, type LabelCount, type MonthPoint } from './overview-charts';
import { BatchAnalyticsTable, type BatchAnalytics } from './batch-analytics';
import { FilterBar, type FilterOptions } from './filter-bar';

// Mirrors the API's OverviewReport (reports.service.ts).
interface OverviewReport {
  kpis: {
    totalAssets: number;
    activeAssets: number;
    inStock: number;
    awaitingAudit: number;
    readyForSale: number;
    soldUnits: number;
    lots: number;
    subLots: number;
    activePallets: number;
    palletUnits: number;
    consumableItems: number;
    consumableUnits: number;
    warehouseValue: number;
    revenue: number;
    costOfSold: number;
    profit: number;
    marginPct: number | null;
    users: number;
  };
  byCategory: LabelCount[];
  byManufacturer: { label: string; count: number; pct: number; avgGrade: string | null }[];
  byGrade: LabelCount[];
  byAuditStatus: LabelCount[];
}

interface LotProfit {
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

interface SupplierPerformance {
  label: string;
  batches: number;
  assets: number;
  avgGrade: string | null;
  unitsSold: number;
  revenue: number;
  profit: number;
  returnRate: number | null;
}

interface PalletAnalytics {
  summary: { totalPallets: number; activePallets: number; shippedPallets: number; unitsOnHand: number; unitsSold: number; revenue: number };
  pallets: {
    id: string;
    palletNumber: string;
    description: string | null;
    status: string;
    location: string | null;
    supplier: string | null;
    buyer: string | null;
    entryLayout: string;
    createdAt: string;
    variants: number;
    unitsOnPallet: number;
    unitsSold: number;
    revenue: number;
    profit: number;
  }[];
}

interface ActivityEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  createdAt: string;
  user: { id: string; name: string } | null;
}

interface ConsumablesReport {
  summary: { items: number; unitsOnHand: number; outOfStock: number; lowStock: number; usedInRange: number; usedThisMonth: number; avgMonthlyUsage: number };
  monthly: { month: string; used: number; received: number }[];
  topUsage: { label: string; qty: number }[];
  topOrdered: { label: string; qty: number }[];
  lowOrOut: { id: string; name: string; sku: string | null; quantity: number; status: string }[];
}

interface UserPerformance {
  userId: string;
  name: string;
  role: string;
  batchesCreated: number;
  assetsAdded: number;
  assetsAudited: number;
  itemsSold: number;
  itemsReturned: number;
  avgProcessingDays: number | null;
  lastActivity: string | null;
}

interface WarehouseThroughput {
  metrics: { received: number; scanned: number; audited: number; shipped: number; sold: number; returned: number };
  processedAssets: number;
  avgProcessingDays: number | null;
  daily: DayPoint[];
  windowLabel: string;
}

interface SalesAnalytics {
  summary: {
    soldUnits: number;
    revenue: number;
    cost: number;
    profit: number;
    marginPct: number | null;
    avgSellPrice: number | null;
    soldToday: number;
    soldThisMonth: number;
  };
  monthly: MonthPoint[];
  topManufacturers: { label: string; units: number; revenue: number }[];
  topModels: { label: string; units: number; revenue: number }[];
  topCategories: { label: string; units: number; revenue: number }[];
  bySupplier: { label: string; units: number; revenue: number; cost: number; profit: number; marginPct: number | null }[];
}

// Date presets: each returns the [from, to] bounds applied to the sales
// metrics (sold / revenue / profit). Snapshot metrics ignore the range.
const PRESETS: { key: string; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'lastmonth', label: 'Last month' },
  { key: 'year', label: 'This year' },
  { key: 'all', label: 'All time' },
];

function rangeBounds(range: string, fromStr?: string, toStr?: string): { from?: Date; to?: Date } {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  switch (range) {
    case 'today':
      return { from: startOfDay(now) };
    case '7d':
      return { from: new Date(now.getTime() - 7 * 86_400_000) };
    case '30d':
      return { from: new Date(now.getTime() - 30 * 86_400_000) };
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1) };
    case 'lastmonth':
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59),
      };
    case 'year':
      return { from: new Date(now.getFullYear(), 0, 1) };
    case 'custom': {
      const from = fromStr ? new Date(fromStr) : undefined;
      const to = toStr ? new Date(`${toStr}T23:59:59`) : undefined;
      return {
        from: from && !isNaN(from.getTime()) ? from : undefined,
        to: to && !isNaN(to.getTime()) ? to : undefined,
      };
    }
    default:
      return {};
  }
}

const GRADE_ORDER = ['Grade A', 'Grade B', 'Grade C', 'Grade D', 'For Parts', 'Scrap', 'Ungraded'];

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    batchId?: string;
    supplier?: string;
    manufacturer?: string;
    category?: string;
    grade?: string;
  }>;
}) {
  const params = await searchParams;
  const range = params.range ?? 'all';
  const user = await getSessionUser();
  const canSee = user?.role === 'admin' || user?.role === 'manager';

  const { from, to } = rangeBounds(range, params.from, params.to);
  const qs = new URLSearchParams();
  if (from) qs.set('from', from.toISOString());
  if (to) qs.set('to', to.toISOString());

  // The device-based sections also take the dimension filters; other sections
  // just take the date range.
  const deviceQs = new URLSearchParams(qs);
  for (const key of ['batchId', 'supplier', 'manufacturer', 'category', 'grade'] as const) {
    if (params[key]) deviceQs.set(key, params[key]!);
  }
  const anyFilter = ['batchId', 'supplier', 'manufacturer', 'category', 'grade'].some((k) => params[k as keyof typeof params]);

  const [overview, profit, sales, batchAnalytics, warehouse, userPerf, consumables, activity, palletAnalytics, suppliers, filterOptions] = await Promise.all([
    canSee
      ? apiFetch<OverviewReport>(`/reports/overview?${deviceQs.toString()}`).catch(() => null)
      : Promise.resolve(null),
    canSee ? apiFetch<LotProfit[]>('/reports/profit').catch(() => [] as LotProfit[]) : Promise.resolve([] as LotProfit[]),
    canSee ? apiFetch<SalesAnalytics>(`/reports/sales?${deviceQs.toString()}`).catch(() => null) : Promise.resolve(null),
    canSee ? apiFetch<BatchAnalytics[]>(`/reports/batches?${deviceQs.toString()}`).catch(() => [] as BatchAnalytics[]) : Promise.resolve([] as BatchAnalytics[]),
    canSee ? apiFetch<WarehouseThroughput>(`/reports/warehouse?${qs.toString()}`).catch(() => null) : Promise.resolve(null),
    canSee ? apiFetch<UserPerformance[]>(`/reports/users?${qs.toString()}`).catch(() => [] as UserPerformance[]) : Promise.resolve([] as UserPerformance[]),
    canSee ? apiFetch<ConsumablesReport>(`/reports/consumables?${qs.toString()}`).catch(() => null) : Promise.resolve(null),
    canSee ? apiFetch<ActivityEntry[]>('/activity?limit=18').catch(() => [] as ActivityEntry[]) : Promise.resolve([] as ActivityEntry[]),
    canSee ? apiFetch<PalletAnalytics>(`/reports/pallets?${qs.toString()}`).catch(() => null) : Promise.resolve(null),
    canSee ? apiFetch<SupplierPerformance[]>(`/reports/suppliers?${deviceQs.toString()}`).catch(() => [] as SupplierPerformance[]) : Promise.resolve([] as SupplierPerformance[]),
    canSee ? apiFetch<FilterOptions>('/reports/filter-options').catch(() => null) : Promise.resolve(null),
  ]);

  if (!canSee || !overview) {
    return (
      <>
        <Nav />
        <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="mt-4 text-sm text-neutral-500">
            {canSee ? 'Reports are temporarily unavailable — try again shortly.' : 'Reports are available to managers and admins.'}
          </p>
        </main>
    </>
    );
  }

  const k = overview.kpis;
  const rangeLabel =
    range === 'custom'
      ? 'custom range'
      : (PRESETS.find((p) => p.key === range)?.label ?? 'All time').toLowerCase();

  const byGradeOrdered = [...overview.byGrade].sort(
    (a, b) => GRADE_ORDER.indexOf(a.label) - GRADE_ORDER.indexOf(b.label),
  );
  const byAuditLabelled = overview.byAuditStatus.map((r) => ({
    label: formatLabel(r.label),
    count: r.count,
  }));

  const profitTotals = profit.reduce(
    (acc, r) => {
      acc.revenue += r.revenue;
      acc.costOfSold += r.costOfSold;
      acc.profit += r.profit;
      return acc;
    },
    { revenue: 0, costOfSold: 0, profit: 0 },
  );

  const kpiCards: { label: string; value: string; sub?: string; href: string; ranged?: boolean }[] = [
    { label: 'Total devices', value: String(k.totalAssets), sub: `${k.activeAssets} active`, href: '/assets' },
    { label: 'In stock', value: String(k.inStock), href: '/assets?stockStatus=in_stock' },
    { label: 'Awaiting audit', value: String(k.awaitingAudit), href: '/assets' },
    { label: 'Ready for sale', value: String(k.readyForSale), href: '/assets?auditStatus=ready_for_sale' },
    { label: 'Units sold', value: String(k.soldUnits), sub: rangeLabel, href: '/sold', ranged: true },
    { label: 'Lots', value: String(k.lots), sub: `${k.subLots} sub-lots`, href: '/batches' },
    { label: 'Active pallets', value: String(k.activePallets), sub: `${k.palletUnits} units`, href: '/pallets' },
    { label: 'Consumables', value: String(k.consumableUnits), sub: `${k.consumableItems} items`, href: '/stock' },
    { label: 'Warehouse value', value: money(k.warehouseValue), sub: 'at cost', href: '/inventory' },
    { label: 'Revenue', value: money(k.revenue), sub: rangeLabel, href: '/sold', ranged: true },
    { label: 'Profit', value: money(k.profit), sub: rangeLabel, href: '/sold', ranged: true },
    {
      label: 'Margin',
      value: k.marginPct == null ? '—' : `${k.marginPct.toFixed(1)}%`,
      sub: rangeLabel,
      href: '/sold',
      ranged: true,
    },
    { label: 'Users', value: String(k.users), href: '/users' },
  ];

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Reports</h1>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <a
              href={`/api/reports/export-xlsx?${deviceQs.toString()}`}
              className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-3 py-1.5 font-medium text-white"
            >
              Export Excel
            </a>
            <a
              href={`/api/reports/export-pdf?${deviceQs.toString()}`}
              className="rounded-md border border-[var(--field-border)] px-3 py-1.5 text-neutral-900 hover:bg-white"
            >
              Export PDF
            </a>
            <a href="/api/reports/assets-csv" className="text-neutral-500 underline">
              Assets CSV
            </a>
          </div>
        </div>

        {/* Date range — bounds the sales figures (sold / revenue / profit / margin). */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => {
            const sp = new URLSearchParams();
            if (p.key !== 'all') sp.set('range', p.key);
            for (const k of ['batchId', 'supplier', 'manufacturer', 'category', 'grade'] as const) {
              if (params[k]) sp.set(k, params[k]!);
            }
            const href = sp.toString() ? `/reports?${sp.toString()}` : '/reports';
            return (
              <Link
                key={p.key}
                href={href}
                aria-current={range === p.key ? 'true' : undefined}
                className={
                  'rounded-md px-3 py-1.5 text-xs ' +
                  (range === p.key
                    ? 'bg-neutral-100 font-semibold text-neutral-900 ring-1 ring-neutral-500'
                    : 'border border-[var(--field-border)] text-neutral-700 hover:bg-white')
                }
              >
                {p.label}
              </Link>
            );
          })}
          <form action="/reports" className="flex flex-wrap items-center gap-1 text-xs text-neutral-700">
            <input type="hidden" name="range" value="custom" />
            {(['batchId', 'supplier', 'manufacturer', 'category', 'grade'] as const).map((k) =>
              params[k] ? <input key={k} type="hidden" name={k} value={params[k]} /> : null,
            )}
            <input type="date" name="from" aria-label="From date" defaultValue={params.from ?? ''} className="field-underline px-2 py-1 text-xs" />
            <span aria-hidden="true">–</span>
            <input type="date" name="to" aria-label="To date" defaultValue={params.to ?? ''} className="field-underline px-2 py-1 text-xs" />
            <button type="submit" className="rounded-md border border-[var(--field-border)] px-2 py-1 text-neutral-700 hover:bg-white">
              Apply
            </button>
          </form>
        </div>

        {/* Cross-report dimension filters */}
        {filterOptions && <FilterBar options={filterOptions} />}
        {anyFilter && (
          <p className="mt-1 text-xs text-neutral-500">
            Filters apply to the Inventory, Sales, Batch &amp; lot and Supplier sections. Warehouse,
            User, Consumables, Pallet and Activity sections show all data.
          </p>
        )}

        {/* Executive summary */}
        <section className="mt-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {kpiCards.map((c) => (
              <Link
                key={c.label}
                href={c.href}
                className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 transition hover:border-neutral-300"
              >
                <div className="text-xs uppercase tracking-wide text-neutral-500">{c.label}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">{c.value}</div>
                {c.sub && <div className="mt-0.5 text-xs text-neutral-500">{c.sub}</div>}
              </Link>
            ))}
          </div>
        </section>

        {/* Inventory analytics — active (unsold) inventory */}
        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-500">
            Inventory analytics <span className="text-neutral-500">(active inventory)</span>
          </h2>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-4">
              <h3 className="text-sm font-medium text-neutral-700">By category</h3>
              <div className="mt-3">
                {overview.byCategory.length > 0 ? (
                  <CategoryDonut data={overview.byCategory} />
                ) : (
                  <p className="py-8 text-center text-sm text-neutral-500">No active devices.</p>
                )}
              </div>
            </div>

            <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-4">
              <h3 className="text-sm font-medium text-neutral-700">By manufacturer</h3>
              <div className="mt-3">
                {overview.byManufacturer.length > 0 ? (
                  <>
                    <CountBars data={overview.byManufacturer} color="blue" />
                    <table className="mt-3 w-full text-left text-xs">
                <caption className="sr-only">Units and average grade by manufacturer</caption>
                      <thead className="text-neutral-500">
                        <tr>
                          <th scope="col" className="py-1">Manufacturer</th>
                          <th scope="col" className="py-1 text-right">Units</th>
                          <th scope="col" className="py-1 text-right">Share</th>
                          <th scope="col" className="py-1 text-right">Avg grade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.byManufacturer.slice(0, 8).map((m) => (
                          <tr key={m.label} className="border-t border-neutral-200">
                            <td className="py-1 text-neutral-700">{m.label}</td>
                            <td className="py-1 text-right tabular-nums text-neutral-500">{m.count}</td>
                            <td className="py-1 text-right tabular-nums text-neutral-500">{m.pct.toFixed(0)}%</td>
                            <td className="py-1 text-right text-neutral-500">{m.avgGrade ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <p className="py-8 text-center text-sm text-neutral-500">No active devices.</p>
                )}
              </div>
            </div>

            <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-4">
              <h3 className="text-sm font-medium text-neutral-700">By condition grade</h3>
              <div className="mt-3">
                {byGradeOrdered.length > 0 ? (
                  <CountBars data={byGradeOrdered} color="aqua" />
                ) : (
                  <p className="py-8 text-center text-sm text-neutral-500">No active devices.</p>
                )}
              </div>
            </div>

            <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-4">
              <h3 className="text-sm font-medium text-neutral-700">By audit status</h3>
              <div className="mt-3">
                {byAuditLabelled.length > 0 ? (
                  <CountBars data={byAuditLabelled} color="blue" />
                ) : (
                  <p className="py-8 text-center text-sm text-neutral-500">No active devices.</p>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Sales & Finance analytics */}
        {sales && (
          <section className="mt-8">
            <h2 className="text-sm font-medium text-neutral-500">
              Sales &amp; finance <span className="text-neutral-500">({rangeLabel})</span>
            </h2>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                { label: 'Sold today', value: String(sales.summary.soldToday) },
                { label: 'Sold this month', value: String(sales.summary.soldThisMonth) },
                { label: 'Revenue', value: money(sales.summary.revenue) },
                { label: 'Profit', value: money(sales.summary.profit) },
                {
                  label: 'Avg sell price',
                  value: sales.summary.avgSellPrice == null ? '—' : money(sales.summary.avgSellPrice),
                },
                {
                  label: 'Avg margin',
                  value: sales.summary.marginPct == null ? '—' : `${sales.summary.marginPct.toFixed(1)}%`,
                },
              ].map((c) => (
                <div key={c.label} className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                  <div className="text-xs uppercase tracking-wide text-neutral-500">{c.label}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums">{c.value}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-4 lg:col-span-2">
                <h3 className="text-sm font-medium text-neutral-700">
                  Revenue &amp; profit <span className="text-neutral-500">(last 12 months)</span>
                </h3>
                <div className="mt-3">
                  <MonthlyTrend
                    data={sales.monthly}
                    series={[
                      { key: 'revenue', label: 'Revenue', color: 'blue' },
                      { key: 'profit', label: 'Profit', color: 'aqua' },
                    ]}
                    format="gbp"
                  />
                </div>
              </div>

              <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-4">
                <h3 className="text-sm font-medium text-neutral-700">Top manufacturers</h3>
                <div className="mt-3">
                  {sales.topManufacturers.length > 0 ? (
                    <CountBars
                      data={sales.topManufacturers.map((m) => ({ label: m.label, count: m.units }))}
                      color="aqua"
                      max={6}
                    />
                  ) : (
                    <p className="py-8 text-center text-sm text-neutral-500">No sales in this range.</p>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <TopTable title="Top models" rows={sales.topModels} />
              <TopTable title="Best-selling categories" rows={sales.topCategories} />
            </div>

            <div role="region" aria-label="Units by manufacturer" tabIndex={0} className="mt-4 overflow-x-auto rounded-lg border border-neutral-200">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Sales performance by supplier</caption>
                <thead className="bg-neutral-50 text-neutral-500">
                  <tr>
                    <th scope="col" className="px-3 py-2">Supplier</th>
                    <th scope="col" className="px-3 py-2 text-right">Units</th>
                    <th scope="col" className="px-3 py-2 text-right">Revenue</th>
                    <th scope="col" className="px-3 py-2 text-right">Cost</th>
                    <th scope="col" className="px-3 py-2 text-right">Profit</th>
                    <th scope="col" className="px-3 py-2 text-right">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.bySupplier.map((s) => (
                    <tr key={s.label} className="border-t border-neutral-200">
                      <td className="px-3 py-2 text-neutral-900">{s.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{s.units}</td>
                      <td className="px-3 py-2 text-right text-neutral-700">{money(s.revenue)}</td>
                      <td className="px-3 py-2 text-right text-neutral-500">{money(s.cost)}</td>
                      <td
                        className={
                          'px-3 py-2 text-right font-medium ' +
                          (s.profit > 0 ? 'text-emerald-700' : s.profit < 0 ? 'text-red-600' : 'text-neutral-700')
                        }
                      >
                        {money(s.profit)}
                      </td>
                      <td className="px-3 py-2 text-right text-neutral-500">
                        {s.marginPct == null ? '—' : `${s.marginPct.toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                  {sales.bySupplier.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-neutral-500">
                        No supplier-attributed device sales in this range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Sold-today/this-month are fixed windows; other figures follow the selected range. Profit
              by supplier covers device sales (pallet goods aren&apos;t attributed to a supplier).
            </p>
          </section>
        )}

        {/* Supplier performance */}
        {suppliers.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-medium text-neutral-500">
              Supplier performance <span className="text-neutral-500">(revenue/profit: {rangeLabel})</span>
            </h2>
            <div role="region" aria-label="Sales by supplier" tabIndex={0} className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Supplier performance: lots, assets, grade, sales and returns</caption>
                <thead className="bg-neutral-50 text-neutral-500">
                  <tr>
                    <th scope="col" className="px-3 py-2">Supplier</th>
                    <th scope="col" className="px-3 py-2 text-right">Lots</th>
                    <th scope="col" className="px-3 py-2 text-right">Assets</th>
                    <th scope="col" className="px-3 py-2 text-right">Avg grade</th>
                    <th scope="col" className="px-3 py-2 text-right">Sold</th>
                    <th scope="col" className="px-3 py-2 text-right">Revenue</th>
                    <th scope="col" className="px-3 py-2 text-right">Profit</th>
                    <th scope="col" className="px-3 py-2 text-right">Return rate</th>
                  </tr>
                </thead>
                <tbody>
                  {suppliers.map((s) => (
                    <tr key={s.label} className="border-t border-neutral-200 hover:bg-neutral-50">
                      <td className="px-3 py-2 text-neutral-900">{s.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{s.batches}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-700">{s.assets}</td>
                      <td className="px-3 py-2 text-right text-neutral-500">{s.avgGrade ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{s.unitsSold || '—'}</td>
                      <td className="px-3 py-2 text-right text-neutral-700">{s.revenue > 0 ? money(s.revenue) : '—'}</td>
                      <td
                        className={
                          'px-3 py-2 text-right font-medium ' +
                          (s.profit > 0 ? 'text-emerald-700' : s.profit < 0 ? 'text-red-600' : 'text-neutral-700')
                        }
                      >
                        {s.revenue > 0 ? money(s.profit) : '—'}
                      </td>
                      <td
                        className={
                          'px-3 py-2 text-right tabular-nums ' +
                          (s.returnRate == null ? 'text-neutral-500' : s.returnRate > 20 ? 'text-amber-700' : 'text-neutral-500')
                        }
                      >
                        {s.returnRate == null ? '—' : `${s.returnRate.toFixed(0)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Suppliers are taken from each lot&apos;s source. Lots, assets and average grade are
              lifetime; revenue and profit follow the range. Return rate is a lifetime quality signal
              (returned vs sold events for the supplier&apos;s devices).
            </p>
          </section>
        )}

        {/* Batch & lot performance — expandable Batch → Sub-lot drill-down */}
        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-neutral-500">
              Batch &amp; lot performance{' '}
              <span className="text-neutral-500">
                (revenue/profit: {rangeLabel} · totals:{' '}
                {money(profitTotals.revenue)} rev / {money(profitTotals.profit)} profit)
              </span>
            </h2>
            <a href="/api/reports/profit-csv" className="text-sm text-neutral-700 underline">
              Export profit CSV
            </a>
          </div>
          <BatchAnalyticsTable rows={batchAnalytics} />
          <p className="mt-2 text-xs text-neutral-500">
            Expand a lot to see its sub-lots (assets, sold, avg grade, % audited, cost, revenue).
            Revenue/profit follow the selected range; asset counts and cost are current totals.
            Pallets are separate containers, not children of a batch, so they aren&apos;t counted here.
          </p>
        </section>

        {/* Pallet analytics — standalone pallet list */}
        {palletAnalytics && (
          <section className="mt-8">
            <h2 className="text-sm font-medium text-neutral-500">
              Pallet analytics{' '}
              <span className="text-neutral-500">
                ({palletAnalytics.summary.activePallets} active ·{' '}
                {palletAnalytics.summary.shippedPallets} shipped ·{' '}
                {palletAnalytics.summary.unitsOnHand.toLocaleString('en-GB')} units on hand ·{' '}
                {palletAnalytics.summary.unitsSold.toLocaleString('en-GB')} sold {rangeLabel})
              </span>
            </h2>
            <div role="region" aria-label="Supplier performance" tabIndex={0} className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Consumable stock lines and their status</caption>
                <thead className="bg-neutral-50 text-neutral-500">
                  <tr>
                    <th scope="col" className="px-3 py-2">Pallet</th>
                    <th scope="col" className="px-3 py-2">Description</th>
                    <th scope="col" className="px-3 py-2">Status</th>
                    <th scope="col" className="px-3 py-2">Entry</th>
                    <th scope="col" className="px-3 py-2 text-right">Variants</th>
                    <th scope="col" className="px-3 py-2 text-right">Units</th>
                    <th scope="col" className="px-3 py-2 text-right">Sold</th>
                    <th scope="col" className="px-3 py-2 text-right">Revenue</th>
                    <th scope="col" className="px-3 py-2">Location</th>
                    <th scope="col" className="px-3 py-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {palletAnalytics.pallets.map((p) => (
                    <tr key={p.id} className="border-t border-neutral-200 hover:bg-neutral-50">
                      <td className="px-3 py-2 text-neutral-900">
                        <Link href={`/pallets/${p.id}`} className="underline">
                          {p.palletNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-neutral-500">{p.description ?? '—'}</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            'rounded-full px-2 py-0.5 text-xs ' +
                            (p.status === 'shipped'
                              ? 'bg-neutral-100 text-neutral-700'
                              : p.status === 'ready'
                                ? 'bg-amber-50 text-amber-700'
                                : 'bg-sky-50 text-sky-700')
                          }
                        >
                          {formatLabel(p.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-neutral-500">
                        {p.entryLayout === 'spec' ? 'Spec grid' : 'Variant'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{p.variants}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-700">{p.unitsOnPallet}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{p.unitsSold || '—'}</td>
                      <td className="px-3 py-2 text-right text-neutral-700">
                        {p.revenue > 0 ? money(p.revenue) : '—'}
                      </td>
                      <td className="px-3 py-2 text-neutral-500">{p.location ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-neutral-500">
                        {new Date(p.createdAt).toLocaleDateString('en-GB')}
                      </td>
                    </tr>
                  ))}
                  {palletAnalytics.pallets.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-3 py-6 text-center text-neutral-500">
                        No pallets yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Units are current pallet contents; sold/revenue follow the selected range. Pallets are
              standalone containers, so they have no parent batch/lot or assigned user.
            </p>
          </section>
        )}

        {/* Warehouse operations — throughput over the range */}
        {warehouse && (
          <section className="mt-8">
            <h2 className="text-sm font-medium text-neutral-500">
              Warehouse operations <span className="text-neutral-500">({rangeLabel})</span>
            </h2>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {[
                { label: 'Received', value: warehouse.metrics.received },
                { label: 'Scanned', value: warehouse.metrics.scanned },
                { label: 'Audited', value: warehouse.metrics.audited },
                { label: 'Shipped', value: warehouse.metrics.shipped },
                { label: 'Sold', value: warehouse.metrics.sold },
                { label: 'Returned', value: warehouse.metrics.returned },
              ].map((c) => (
                <div key={c.label} className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                  <div className="text-xs uppercase tracking-wide text-neutral-500">{c.label}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums">{c.value}</div>
                </div>
              ))}
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                <div className="text-xs uppercase tracking-wide text-neutral-500">Avg processing</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {warehouse.avgProcessingDays == null
                    ? '—'
                    : `${warehouse.avgProcessingDays.toFixed(1)}d`}
                </div>
                <div className="mt-0.5 text-[10px] text-neutral-500">intake → audit</div>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-neutral-200 bg-white p-4">
              <h3 className="text-sm font-medium text-neutral-700">
                Throughput per day{' '}
                <span className="text-neutral-500">({warehouse.windowLabel})</span>
              </h3>
              <div className="mt-3">
                <DailyBars data={warehouse.daily} />
              </div>
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Counts are warehouse events in the range (received, scanned, audited, shipped, sold,
              returned). Average processing time is the mean days from a device&apos;s intake to its
              first audit, over devices audited in the range.
            </p>
          </section>
        )}

        {/* Consumables — bulk stock usage */}
        {consumables && (
          <section className="mt-8">
            <h2 className="text-sm font-medium text-neutral-500">
              Consumables <span className="text-neutral-500">({rangeLabel})</span>
            </h2>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                { label: 'On hand', value: consumables.summary.unitsOnHand.toLocaleString('en-GB'), sub: `${consumables.summary.items} items` },
                { label: 'Used', value: consumables.summary.usedInRange.toLocaleString('en-GB'), sub: rangeLabel },
                { label: 'Used this month', value: consumables.summary.usedThisMonth.toLocaleString('en-GB') },
                { label: 'Avg monthly use', value: consumables.summary.avgMonthlyUsage.toLocaleString('en-GB') },
                { label: 'Low stock', value: String(consumables.summary.lowStock) },
                { label: 'Out of stock', value: String(consumables.summary.outOfStock) },
              ].map((c) => (
                <div key={c.label} className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                  <div className="text-xs uppercase tracking-wide text-neutral-500">{c.label}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums">{c.value}</div>
                  {c.sub && <div className="mt-0.5 text-[10px] text-neutral-500">{c.sub}</div>}
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-4 lg:col-span-2">
                <h3 className="text-sm font-medium text-neutral-700">
                  Consumption &amp; replenishment <span className="text-neutral-500">(last 12 months)</span>
                </h3>
                <div className="mt-3">
                  <MonthlyTrend
                    data={consumables.monthly}
                    series={[
                      { key: 'used', label: 'Used', color: 'blue' },
                      { key: 'received', label: 'Received', color: 'aqua' },
                    ]}
                    format="count"
                    unitLabel="units"
                  />
                </div>
              </div>

              <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-4">
                <h3 className="text-sm font-medium text-neutral-700">Highest usage</h3>
                <div className="mt-3">
                  {consumables.topUsage.length > 0 ? (
                    <CountBars data={consumables.topUsage.map((u) => ({ label: u.label, count: u.qty }))} color="blue" max={6} />
                  ) : (
                    <p className="py-8 text-center text-sm text-neutral-500">No usage in this range.</p>
                  )}
                </div>
              </div>
            </div>

            {(consumables.topOrdered.length > 0 || consumables.lowOrOut.length > 0) && (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <TopTable title="Most ordered (received)" rows={consumables.topOrdered.map((o) => ({ label: o.label, units: o.qty, revenue: 0 }))} hideRevenue />
                <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-4">
                  <h3 className="text-sm font-medium text-neutral-700">Low / out of stock</h3>
                  {consumables.lowOrOut.length > 0 ? (
                    <ul className="mt-3 space-y-1.5 text-sm">
                      {consumables.lowOrOut.map((l) => (
                        <li key={l.id} className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-neutral-700">
                            {l.name}
                            {l.sku && <span className="ml-1 text-xs text-neutral-500">{l.sku}</span>}
                          </span>
                          <span
                            className={
                              'rounded-full px-2 py-0.5 text-xs ' +
                              (l.status === 'out_of_stock'
                                ? 'bg-red-50 text-red-700'
                                : 'bg-amber-50 text-amber-700')
                            }
                          >
                            {l.quantity} left
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-6 text-center text-sm text-neutral-500">Everything is well stocked.</p>
                  )}
                </div>
              </div>
            )}
            <p className="mt-2 text-xs text-neutral-500">
              Usage/ordering come from the stock movement log (used vs received). Stock levels are
              current; used-this-month and the trend are fixed windows.
            </p>
          </section>
        )}

        {/* User performance — comparison table */}
        {userPerf.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-medium text-neutral-500">
              User performance <span className="text-neutral-500">({rangeLabel})</span>
            </h2>
            <div role="region" aria-label="Consumable stock" tabIndex={0} className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Per-user activity</caption>
                <thead className="bg-neutral-50 text-neutral-500">
                  <tr>
                    <th scope="col" className="px-3 py-2">User</th>
                    <th scope="col" className="px-3 py-2">Role</th>
                    <th scope="col" className="px-3 py-2 text-right">Lots created</th>
                    <th scope="col" className="px-3 py-2 text-right">Assets added</th>
                    <th scope="col" className="px-3 py-2 text-right">Audited</th>
                    <th scope="col" className="px-3 py-2 text-right">Items sold</th>
                    <th scope="col" className="px-3 py-2 text-right">Returned</th>
                    <th scope="col" className="px-3 py-2 text-right">Avg processing</th>
                    <th scope="col" className="px-3 py-2">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {userPerf.map((u) => (
                    <tr key={u.userId} className="border-t border-neutral-200 hover:bg-neutral-50">
                      <td className="px-3 py-2 text-neutral-900">{u.name}</td>
                      <td className="px-3 py-2 text-neutral-500">{formatLabel(u.role)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{u.batchesCreated}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{u.assetsAdded}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-700">{u.assetsAudited}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-700">{u.itemsSold}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{u.itemsReturned}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                        {u.avgProcessingDays == null ? '—' : `${u.avgProcessingDays.toFixed(1)}d`}
                      </td>
                      <td className="px-3 py-2 text-neutral-500">
                        {u.lastActivity ? new Date(u.lastActivity).toLocaleString('en-GB') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Actions attributed to the acting user within the range; last activity is their most
              recent action of any kind. Assets added counts API/manual creations (bulk scan‑ins
              carry no user). Managers see only their own row.
            </p>
          </section>
        )}

        {/* Activity timeline — the live feed of recent actions */}
        {activity.length > 0 && (
          <section className="mt-8">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-neutral-500">Activity timeline</h2>
              <Link href="/activity" className="text-sm text-neutral-500 hover:text-neutral-900">
                View all →
              </Link>
            </div>
            <ol className="mt-3 rounded-lg border border-neutral-200 bg-white p-4">
              {activity.map((e, i) => {
                const href = activityHref(e);
                return (
                  <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                    {/* connector line */}
                    {i < activity.length - 1 && (
                      <span className="absolute left-[5px] top-3 h-full w-px bg-neutral-100" aria-hidden />
                    )}
                    <span
                      className="relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: activityColor(e.action) }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-neutral-900">
                        {href ? (
                          <Link href={href} className="hover:underline">
                            {e.summary}
                          </Link>
                        ) : (
                          e.summary
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-neutral-500">
                        {e.user?.name ?? 'System'} · {relativeTime(e.createdAt)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </main>
  </>
  );
}

// Where an activity entry links (same mapping as the /activity page).
function activityHref(e: ActivityEntry): string | null {
  if (!e.entityId) return null;
  if (e.entityType === 'batch') return `/batches/${e.entityId}`;
  if (e.entityType === 'asset') return `/assets/${e.entityId}`;
  return null;
}

// Timeline dot colour by action category (matches the light chart palette).
// Each dot is accompanied by its action label, so identity is never colour-alone.
function activityColor(action: string): string {
  if (action.includes('sold')) return '#1baf7a'; // aqua — money in
  if (action.includes('returned')) return '#eda100'; // yellow
  if (action.includes('deleted')) return '#e34948'; // red
  if (action.includes('created')) return '#2a78d6'; // blue
  if (action.includes('moved')) return '#4a3aa7'; // violet
  return '#8a8a85'; // neutral (updated/other)
}

// Compact relative time ("5m ago", "2h ago", "3d ago"); computed at render.
function relativeTime(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-GB');
}

// A compact ranked list (top models / categories): units + revenue, with a
// thin proportional bar so magnitude reads at a glance.
function TopTable({
  title,
  rows,
  hideRevenue = false,
}: {
  title: string;
  rows: { label: string; units: number; revenue: number }[];
  hideRevenue?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.units));
  return (
    <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-4">
      <h3 className="text-sm font-medium text-neutral-700">{title}</h3>
      {rows.length > 0 ? (
        <ul className="mt-3 space-y-2 text-sm">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center gap-3">
              <span className="w-40 truncate text-neutral-700">{r.label}</span>
              <span className="relative h-2 flex-1 overflow-hidden rounded-sm bg-neutral-100">
                <span
                  className="absolute inset-y-0 left-0 rounded-sm bg-[#3987e5]"
                  style={{ width: `${(r.units / max) * 100}%` }}
                />
              </span>
              <span className="w-10 text-right tabular-nums text-neutral-500">{r.units}</span>
              {!hideRevenue && (
                <span className="w-16 text-right tabular-nums text-neutral-500">{money(r.revenue)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-sm text-neutral-500">No sales in this range.</p>
      )}
    </div>
  );
}
