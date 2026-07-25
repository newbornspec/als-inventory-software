import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { money } from '@/lib/money';
import { formatLabel } from '@/lib/asset-options';
import { CategoryDonut, CountBars, MonthlyTrend, type LabelCount, type MonthPoint } from './overview-charts';

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
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const range = params.range ?? 'all';
  const user = await getSessionUser();
  const canSee = user?.role === 'admin' || user?.role === 'manager';

  const { from, to } = rangeBounds(range, params.from, params.to);
  const qs = new URLSearchParams();
  if (from) qs.set('from', from.toISOString());
  if (to) qs.set('to', to.toISOString());

  const [overview, profit, sales] = await Promise.all([
    canSee
      ? apiFetch<OverviewReport>(`/reports/overview?${qs.toString()}`).catch(() => null)
      : Promise.resolve(null),
    canSee ? apiFetch<LotProfit[]>('/reports/profit').catch(() => [] as LotProfit[]) : Promise.resolve([] as LotProfit[]),
    canSee ? apiFetch<SalesAnalytics>(`/reports/sales?${qs.toString()}`).catch(() => null) : Promise.resolve(null),
  ]);

  if (!canSee || !overview) {
    return (
      <main className="min-h-screen bg-neutral-950 text-neutral-100">
        <Nav />
        <div className="p-8">
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="mt-4 text-sm text-neutral-500">
            {canSee ? 'Reports are temporarily unavailable — try again shortly.' : 'Reports are available to managers and admins.'}
          </p>
        </div>
      </main>
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
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Reports</h1>
          <div className="flex items-center gap-3 text-sm">
            <a href="/api/reports/assets-csv" className="text-neutral-300 underline">
              Export assets CSV
            </a>
            <a href="/api/reports/profit-csv" className="text-neutral-300 underline">
              Export profit CSV
            </a>
          </div>
        </div>

        {/* Date range — bounds the sales figures (sold / revenue / profit / margin). */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <Link
              key={p.key}
              href={p.key === 'all' ? '/reports' : `/reports?range=${p.key}`}
              className={
                'rounded-md px-3 py-1.5 text-xs ' +
                (range === p.key
                  ? 'bg-neutral-100 font-medium text-neutral-900'
                  : 'border border-neutral-700 text-neutral-300 hover:bg-neutral-900')
              }
            >
              {p.label}
            </Link>
          ))}
          <form action="/reports" className="flex items-center gap-1 text-xs text-neutral-500">
            <input type="hidden" name="range" value="custom" />
            <input type="date" name="from" defaultValue={params.from ?? ''} className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs" />
            <span>–</span>
            <input type="date" name="to" defaultValue={params.to ?? ''} className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs" />
            <button type="submit" className="rounded-md border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-900">
              Apply
            </button>
          </form>
        </div>

        {/* Executive summary */}
        <section className="mt-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {kpiCards.map((c) => (
              <Link
                key={c.label}
                href={c.href}
                className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 transition hover:border-neutral-600"
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
          <h2 className="text-sm font-medium text-neutral-400">
            Inventory analytics <span className="text-neutral-600">(active inventory)</span>
          </h2>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
              <h3 className="text-sm font-medium text-neutral-300">By category</h3>
              <div className="mt-3">
                {overview.byCategory.length > 0 ? (
                  <CategoryDonut data={overview.byCategory} />
                ) : (
                  <p className="py-8 text-center text-sm text-neutral-500">No active devices.</p>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
              <h3 className="text-sm font-medium text-neutral-300">By manufacturer</h3>
              <div className="mt-3">
                {overview.byManufacturer.length > 0 ? (
                  <>
                    <CountBars data={overview.byManufacturer} color="blue" />
                    <table className="mt-3 w-full text-left text-xs">
                      <thead className="text-neutral-500">
                        <tr>
                          <th className="py-1">Manufacturer</th>
                          <th className="py-1 text-right">Units</th>
                          <th className="py-1 text-right">Share</th>
                          <th className="py-1 text-right">Avg grade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.byManufacturer.slice(0, 8).map((m) => (
                          <tr key={m.label} className="border-t border-neutral-800">
                            <td className="py-1 text-neutral-300">{m.label}</td>
                            <td className="py-1 text-right tabular-nums text-neutral-400">{m.count}</td>
                            <td className="py-1 text-right tabular-nums text-neutral-400">{m.pct.toFixed(0)}%</td>
                            <td className="py-1 text-right text-neutral-400">{m.avgGrade ?? '—'}</td>
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

            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
              <h3 className="text-sm font-medium text-neutral-300">By condition grade</h3>
              <div className="mt-3">
                {byGradeOrdered.length > 0 ? (
                  <CountBars data={byGradeOrdered} color="aqua" />
                ) : (
                  <p className="py-8 text-center text-sm text-neutral-500">No active devices.</p>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
              <h3 className="text-sm font-medium text-neutral-300">By audit status</h3>
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
            <h2 className="text-sm font-medium text-neutral-400">
              Sales &amp; finance <span className="text-neutral-600">({rangeLabel})</span>
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
                <div key={c.label} className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
                  <div className="text-xs uppercase tracking-wide text-neutral-500">{c.label}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums">{c.value}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 lg:col-span-2">
                <h3 className="text-sm font-medium text-neutral-300">
                  Revenue &amp; profit <span className="text-neutral-600">(last 12 months)</span>
                </h3>
                <div className="mt-3">
                  <MonthlyTrend data={sales.monthly} />
                </div>
              </div>

              <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
                <h3 className="text-sm font-medium text-neutral-300">Top manufacturers</h3>
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

            <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-900 text-neutral-400">
                  <tr>
                    <th className="px-3 py-2">Supplier</th>
                    <th className="px-3 py-2 text-right">Units</th>
                    <th className="px-3 py-2 text-right">Revenue</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                    <th className="px-3 py-2 text-right">Profit</th>
                    <th className="px-3 py-2 text-right">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.bySupplier.map((s) => (
                    <tr key={s.label} className="border-t border-neutral-800">
                      <td className="px-3 py-2 text-neutral-200">{s.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-neutral-400">{s.units}</td>
                      <td className="px-3 py-2 text-right text-neutral-300">{money(s.revenue)}</td>
                      <td className="px-3 py-2 text-right text-neutral-400">{money(s.cost)}</td>
                      <td
                        className={
                          'px-3 py-2 text-right font-medium ' +
                          (s.profit > 0 ? 'text-emerald-400' : s.profit < 0 ? 'text-red-400' : 'text-neutral-300')
                        }
                      >
                        {money(s.profit)}
                      </td>
                      <td className="px-3 py-2 text-right text-neutral-400">
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
            <p className="mt-2 text-xs text-neutral-600">
              Sold-today/this-month are fixed windows; other figures follow the selected range. Profit
              by supplier covers device sales (pallet goods aren&apos;t attributed to a supplier).
            </p>
          </section>
        )}

        {/* Finance — profit by purchase lot (device sales) */}
        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-neutral-400">Profit by purchase lot</h2>
            <a href="/api/reports/profit-csv" className="text-sm text-neutral-300 underline">
              Export profit CSV
            </a>
          </div>

          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2">Lot</th>
                  <th className="px-3 py-2">Supplier</th>
                  <th className="px-3 py-2 text-right">Lot cost</th>
                  <th className="px-3 py-2 text-right">Sold / units</th>
                  <th className="px-3 py-2 text-right">Revenue</th>
                  <th className="px-3 py-2 text-right">Cost of sold</th>
                  <th className="px-3 py-2 text-right">Profit</th>
                  <th className="px-3 py-2 text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {profit.map((r) => (
                  <tr key={r.batchId} className="border-t border-neutral-800">
                    <td className="px-3 py-2 text-neutral-200">
                      <Link href={`/batches/${r.batchId}`} className="underline">
                        {r.batchNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-neutral-400">{r.source ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-neutral-400">
                      {r.totalCost != null ? money(r.totalCost) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-400">
                      {r.unitsSold} / {r.units}
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-300">{money(r.revenue)}</td>
                    <td className="px-3 py-2 text-right text-neutral-400">{money(r.costOfSold)}</td>
                    <td
                      className={
                        'px-3 py-2 text-right font-medium ' +
                        (r.profit > 0 ? 'text-emerald-400' : r.profit < 0 ? 'text-red-400' : 'text-neutral-300')
                      }
                    >
                      {money(r.profit)}
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-400">
                      {r.margin == null ? '—' : `${(r.margin * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
                {profit.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-center text-neutral-500">
                      No purchase lots yet.
                    </td>
                  </tr>
                )}
              </tbody>
              {profit.length > 0 && (
                <tfoot>
                  <tr className="border-t border-neutral-700 bg-neutral-900/60 font-medium">
                    <td className="px-3 py-2" colSpan={4}>
                      Total
                    </td>
                    <td className="px-3 py-2 text-right">{money(profitTotals.revenue)}</td>
                    <td className="px-3 py-2 text-right text-neutral-400">{money(profitTotals.costOfSold)}</td>
                    <td
                      className={
                        'px-3 py-2 text-right ' +
                        (profitTotals.profit >= 0 ? 'text-emerald-400' : 'text-red-400')
                      }
                    >
                      {money(profitTotals.profit)}
                    </td>
                    <td className="px-3 py-2" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="mt-2 text-xs text-neutral-600">
            Device sales only — pallet-goods revenue is included in the Revenue/Profit cards above.
            Sale prices are captured when items are marked Sold; unpriced sales count as £0 revenue.
          </p>
        </section>
      </div>
    </main>
  );
}

// A compact ranked list (top models / categories): units + revenue, with a
// thin proportional bar so magnitude reads at a glance.
function TopTable({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; units: number; revenue: number }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.units));
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <h3 className="text-sm font-medium text-neutral-300">{title}</h3>
      {rows.length > 0 ? (
        <ul className="mt-3 space-y-2 text-sm">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center gap-3">
              <span className="w-40 truncate text-neutral-300">{r.label}</span>
              <span className="relative h-2 flex-1 overflow-hidden rounded-sm bg-neutral-800">
                <span
                  className="absolute inset-y-0 left-0 rounded-sm bg-[#3987e5]"
                  style={{ width: `${(r.units / max) * 100}%` }}
                />
              </span>
              <span className="w-10 text-right tabular-nums text-neutral-400">{r.units}</span>
              <span className="w-16 text-right tabular-nums text-neutral-500">{money(r.revenue)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-sm text-neutral-500">No sales in this range.</p>
      )}
    </div>
  );
}
