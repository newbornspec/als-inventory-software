import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';

interface Notification {
  id: string;
  severity: 'critical' | 'warning';
  assetId: string;
  message: string;
}

interface Bucket {
  key: string;
  count: number;
}

interface DashboardSummary {
  totalDevices: number;
  inStock: number;
  sold: number;
  sellThroughPct: number | null;
  revenue: number;
  realizedProfit: number;
  stockAtCost: number;
  byStatus: Bucket[];
  byGrade: Bucket[];
  ageing: Bucket[];
  repairs: { pending: number; inProgress: number; completed: number; spend: number };
  lots: { total: number; reconciled: number };
  consumables: { total: number; lowStock: number; outOfStock: number };
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'good' | 'bad' | 'warn';
}) {
  const color =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'bad'
        ? 'text-red-400'
        : tone === 'warn'
          ? 'text-amber-400'
          : '';
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className={'text-2xl font-semibold ' + color}>{value}</div>
      <div className="mt-1 text-sm text-neutral-400">{label}</div>
    </div>
  );
}

function Bars({ title, rows }: { title: string; rows: Bucket[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div>
      <h3 className="text-sm font-medium text-neutral-400">{title}</h3>
      <div className="mt-3 space-y-2">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-3 text-sm">
            <span className="w-40 shrink-0 truncate text-neutral-300">{formatLabel(r.key)}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-800">
              <div className="h-full bg-neutral-400" style={{ width: `${(r.count / max) * 100}%` }} />
            </div>
            <span className="w-10 shrink-0 text-right text-neutral-400">{r.count}</span>
          </div>
        ))}
        {rows.length === 0 && <p className="text-sm text-neutral-500">No data.</p>}
      </div>
    </div>
  );
}

export default async function DashboardPage() {
  const user = await getSessionUser();
  const canSeeFinance = user?.role === 'admin' || user?.role === 'manager';

  const [notifications, summary] = await Promise.all([
    apiFetch<Notification[]>('/notifications'),
    canSeeFinance
      ? apiFetch<DashboardSummary>('/reports/dashboard')
      : Promise.resolve(null),
  ]);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          {canSeeFinance && (
            <Link href="/reports" className="text-sm text-neutral-400 hover:text-neutral-200">
              Reports →
            </Link>
          )}
        </div>

        {summary && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Tile label="Total devices" value={summary.totalDevices} />
              <Tile label="In stock" value={summary.inStock} />
              <Tile label="Sold" value={summary.sold} />
              <Tile
                label="Sell-through"
                value={summary.sellThroughPct == null ? '—' : `${summary.sellThroughPct}%`}
              />
              <Tile label="Stock value (at cost)" value={money(summary.stockAtCost)} />
              <Tile label="Revenue (sold)" value={money(summary.revenue)} />
              <Tile
                label="Realized profit"
                value={money(summary.realizedProfit)}
                tone={summary.realizedProfit > 0 ? 'good' : summary.realizedProfit < 0 ? 'bad' : undefined}
              />
              <Tile label="Pending repairs" value={summary.repairs.pending + summary.repairs.inProgress} />
              <Tile
                label="Consumables low stock"
                value={summary.consumables.lowStock}
                tone={summary.consumables.lowStock > 0 ? 'warn' : undefined}
              />
              <Tile
                label="Consumables out of stock"
                value={summary.consumables.outOfStock}
                tone={summary.consumables.outOfStock > 0 ? 'bad' : undefined}
              />
            </div>

            <div className="mt-8 grid gap-8 md:grid-cols-2">
              <Bars title="By stock status" rows={summary.byStatus} />
              <Bars title="By condition grade" rows={summary.byGrade} />
              <Bars title="Ageing (in stock)" rows={summary.ageing} />
              <div>
                <h3 className="text-sm font-medium text-neutral-400">Lots &amp; repairs</h3>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-neutral-500">Lots (reconciled / total)</dt>
                    <dd>
                      {summary.lots.reconciled} / {summary.lots.total}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-neutral-500">Repairs in progress</dt>
                    <dd>{summary.repairs.pending + summary.repairs.inProgress}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-neutral-500">Repairs completed</dt>
                    <dd>{summary.repairs.completed}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-neutral-500">Repair spend (completed)</dt>
                    <dd>{money(summary.repairs.spend)}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </>
        )}

        <div className="mt-8">
          <h2 className="text-sm font-medium text-neutral-400">Alerts</h2>
          <ul className="mt-3 space-y-2">
            {notifications.map((n) => (
              <li key={n.id}>
                <Link
                  href={`/assets/${n.assetId}`}
                  className={
                    'block rounded-md border px-4 py-2 text-sm ' +
                    (n.severity === 'critical'
                      ? 'border-red-900 bg-red-950/40 text-red-300'
                      : 'border-amber-900 bg-amber-950/40 text-amber-300')
                  }
                >
                  {n.message}
                </Link>
              </li>
            ))}
            {notifications.length === 0 && (
              <li className="text-sm text-neutral-500">No alerts right now.</li>
            )}
          </ul>
        </div>
      </div>
    </main>
  );
}
