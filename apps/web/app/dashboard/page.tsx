import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';
import {
  ATTENTION_LINKS,
  type OperationsDashboard,
} from '@/lib/actions/dashboard';
import {
  Bar,
  Empty,
  MetricGrid,
  OkBadge,
  RowLink,
  Section,
  SeverityBadge,
  TableScroll,
  Tile,
} from './components';
import { QuickActions } from './quick-actions';
import { LastUpdated } from './refresh';

// The operational control centre. Ordered by the question each block answers:
// what can I do → what do I have → what is wrong → where is it → what moved →
// what is stale → what is coming → what just happened.
//
// Everything on this page comes from one endpoint (GET /dashboard/operations)
// so every figure is from the same instant — the "last updated" time is true for
// all of them, not just the last one to load.

const TH =
  'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500';
// text-left is not redundant here: the row-label cells are <th scope="row"> so
// screen readers announce them with each value, and a th centres itself unless
// told otherwise — which left every first column visibly out of line.
const TD = 'px-4 py-3 text-left text-sm';

export default async function DashboardPage() {
  const user = await getSessionUser();
  const canManage = user?.role === 'admin' || user?.role === 'manager';

  const data = await apiFetch<OperationsDashboard>('/dashboard/operations');
  const { metrics, finance, attention, health } = data;

  const openAttention = attention.filter((a) => a.count > 0);
  const maxStatus = Math.max(1, ...data.byStatus.map((s) => s.count));
  const maxAgeing = Math.max(1, ...data.ageing.map((a) => a.count));
  const movement = [...data.movement.devices, ...data.movement.consumables].filter(
    (m) => m.last30 > 0,
  );

  const healthWord =
    health.status === 'good'
      ? 'Good'
      : health.status === 'needs_attention'
        ? 'Needs attention'
        : 'Action required';

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
                What needs doing right now, and where the stock stands. Every figure links to the
                exact list it counts.
              </p>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-neutral-600">
                {/* The JWT carries email and role, not a display name. */}
                <span>
                  {user?.email ? `Signed in as ${user.email}` : 'Signed in'}
                  {user?.role ? ` · ${formatLabel(user.role)}` : ''}
                </span>
                {/* The WORD carries the state; the tint only repeats it. */}
                <span
                  className={
                    'rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ' +
                    (health.status === 'good'
                      ? 'bg-emerald-50 text-emerald-700'
                      : health.status === 'needs_attention'
                        ? 'bg-amber-50 text-amber-800'
                        : 'bg-red-50 text-red-700')
                  }
                >
                  Inventory health: {healthWord}
                </span>
              </p>
            </div>
            <LastUpdated generatedAt={data.generatedAt} />
          </div>

          {/* Find anything, from anywhere. A plain GET form so it works before
              hydration and with the keyboard alone. */}
          <form
            action="/assets"
            method="get"
            className="mt-4 flex max-w-xl gap-2 rounded-xl border border-neutral-200 bg-white p-3"
          >
            <label htmlFor="dash-search" className="sr-only">
              Search devices by tag, serial or name
            </label>
            <input
              id="dash-search"
              name="search"
              type="search"
              placeholder="Search devices…"
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none"
            />
            <button
              type="submit"
              className="shrink-0 rounded-md bg-[#1a6ef5] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white hover:bg-blue-600"
            >
              Search
            </button>
          </form>

          <Section id="quick-actions" title="Quick actions">
            <QuickActions canManage={canManage} />
          </Section>

          <Section
            id="key-metrics"
            title="Key metrics"
            action={
              canManage ? (
                <Link href="/reports" className="text-sm font-medium text-[#1a6ef5] hover:underline">
                  Full reports
                </Link>
              ) : undefined
            }
          >
            <MetricGrid>
              <Tile label="Total inventory" value={metrics.totalInventory} sub="Devices still held" href="/inventory" />
              <Tile label="In stock" value={metrics.inStock} sub="On the shelf, uncommitted" href="/assets?stockStatus=in_stock" />
              <Tile
                label="Low stock"
                value={metrics.lowStockLines}
                sub="Consumable lines"
                href="/stock?status=low_stock"
                emphasis={metrics.lowStockLines > 0 ? 'alert' : undefined}
              />
              <Tile
                label="Out of stock"
                value={metrics.outOfStockLines}
                sub="Consumable lines"
                href="/stock?status=out_of_stock"
                emphasis={metrics.outOfStockLines > 0 ? 'critical' : undefined}
              />
              <Tile
                label="Stock value"
                value={finance ? money(finance.stockValue) : '—'}
                sub={finance ? 'At allocated cost' : 'Managers only'}
              />
              <Tile label="Sold" value={metrics.sold} sub="Units gone" href={canManage ? '/sold' : undefined} />
              <Tile
                label="Consumable units"
                value={metrics.consumableUnits}
                sub={`${metrics.consumableLines} lines`}
                href="/stock"
              />
              <Tile
                label="Pending actions"
                value={metrics.pendingActions}
                sub="Everything below added up"
                emphasis={metrics.pendingActions > 0 ? 'alert' : undefined}
              />
            </MetricGrid>
            {finance && (
              <p className="mt-3 text-sm text-neutral-600">
                Secondary: revenue {money(finance.revenue)} · realised profit{' '}
                {money(finance.realizedProfit)} · sell-through{' '}
                {finance.sellThroughPct == null ? '—' : `${finance.sellThroughPct}%`}
              </p>
            )}
          </Section>

          <Section
            id="attention"
            title="Attention required"
            description="Each row links to the exact list it counts — nothing here needs searching for."
          >
            {openAttention.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">
                <OkBadge />
                Nothing needs attention right now.
              </div>
            ) : (
              <TableScroll label="Attention required">
                <table className="w-full min-w-[36rem] border-collapse">
                  <caption className="sr-only">
                    Issues needing attention, with the number of items affected and a link to each
                    filtered list
                  </caption>
                  <thead className="bg-neutral-50">
                    <tr>
                      <th scope="col" className={TH}>Issue</th>
                      <th scope="col" className={TH}>Items</th>
                      <th scope="col" className={TH}>Severity</th>
                      <th scope="col" className={TH}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openAttention.map((row) => {
                      const link = ATTENTION_LINKS[row.key];
                      return (
                        <tr key={row.key} className="border-t border-neutral-200">
                          <th scope="row" className={`${TD} font-medium`}>
                            {row.label}
                            <span className="block text-xs font-normal text-neutral-600">
                              {row.detail}
                            </span>
                          </th>
                          <td className={`${TD} tabular-nums`}>{row.count}</td>
                          <td className={TD}>
                            <SeverityBadge severity={row.severity} />
                          </td>
                          <td className={TD}>
                            <RowLink
                              href={link.href}
                              action={link.action}
                              context={`${row.count} ${row.label.toLowerCase()}`}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Section>

          <div className="grid min-w-0 gap-x-4 lg:grid-cols-2">
            <Section id="stock-status" title="Stock status" description="Devices by warehouse status.">
              {data.byStatus.length === 0 ? (
                <Empty>No devices recorded yet.</Empty>
              ) : (
                <TableScroll label="Devices by stock status">
                  <table className="w-full border-collapse">
                    <caption className="sr-only">Number of devices in each stock status</caption>
                    <thead className="bg-neutral-50">
                      <tr>
                        <th scope="col" className={TH}>Status</th>
                        <th scope="col" className={`${TH} w-1/2`}>Share</th>
                        <th scope="col" className={TH}>Devices</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byStatus.map((s) => (
                        <tr key={s.key} className="border-t border-neutral-200">
                          <th scope="row" className={`${TD} font-normal`}>
                            {formatLabel(s.key)}
                          </th>
                          <td className={TD}>
                            <Bar value={s.count} max={maxStatus} />
                          </td>
                          <td className={`${TD} tabular-nums`}>{s.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </Section>

            <Section
              id="by-location"
              title="Inventory by location"
              description="Click a location to see its devices."
            >
              <TableScroll label="Inventory by location">
                <table className="w-full min-w-[40rem] border-collapse">
                  <caption className="sr-only">
                    Devices, value and consumables at each location
                  </caption>
                  <thead className="bg-neutral-50">
                    <tr>
                      <th scope="col" className={TH}>Location</th>
                      <th scope="col" className={TH}>Devices</th>
                      {canManage && <th scope="col" className={TH}>Value</th>}
                      <th scope="col" className={TH}>Low stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.locations.map((l) => {
                      const href = l.id
                        ? `/assets?locationId=${l.id}`
                        : '/assets?noLocation=true';
                      return (
                        <tr key={l.id ?? 'none'} className="border-t border-neutral-200">
                          <th scope="row" className={`${TD} font-medium`}>
                            <Link href={href} className="font-medium text-[#1a6ef5] hover:underline">
                              {l.name}
                            </Link>
                          </th>
                          <td className={`${TD} tabular-nums`}>{l.devices}</td>
                          {canManage && (
                            <td className={`${TD} tabular-nums`}>{money(l.value)}</td>
                          )}
                          <td className={`${TD} tabular-nums`}>
                            {l.lowStockLines > 0 ? (
                              <span className="font-medium text-amber-800">
                                ⚠ {l.lowStockLines} low
                              </span>
                            ) : (
                              <span className="text-neutral-600">0</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {data.locations.length === 0 && (
                      <tr>
                        <td colSpan={canManage ? 4 : 3} className={`${TD} text-neutral-600`}>
                          No locations set up yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </TableScroll>
            </Section>
          </div>

          <Section
            id="movement"
            title="Stock movement"
            description="What has actually happened in the last 7 and 30 days. Only the events this system records are listed."
          >
            {movement.length === 0 ? (
              <Empty>No recorded movement in the last 30 days.</Empty>
            ) : (
              <TableScroll label="Stock movement over the last 7 and 30 days">
                <table className="w-full min-w-[30rem] border-collapse">
                  <caption className="sr-only">
                    Counts of each kind of stock movement over the last 7 and 30 days
                  </caption>
                  <thead className="bg-neutral-50">
                    <tr>
                      <th scope="col" className={TH}>Movement</th>
                      <th scope="col" className={TH}>Last 7 days</th>
                      <th scope="col" className={TH}>Last 30 days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movement.map((m) => (
                      <tr key={m.key + m.label} className="border-t border-neutral-200">
                        <th scope="row" className={`${TD} font-normal`}>
                          {m.label}
                        </th>
                        <td className={`${TD} tabular-nums`}>{m.last7}</td>
                        <td className={`${TD} tabular-nums`}>{m.last30}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Section>

          <div className="grid min-w-0 gap-x-4 lg:grid-cols-2">
            <Section
              id="ageing"
              title="Inventory ageing"
              description="How long devices still held have been in stock, counted from the day they were booked in."
            >
              <TableScroll label="Inventory ageing">
                <table className="w-full border-collapse">
                  <caption className="sr-only">
                    Devices in stock grouped by age, with allocated cost where available
                  </caption>
                  <thead className="bg-neutral-50">
                    <tr>
                      <th scope="col" className={TH}>Age</th>
                      <th scope="col" className={`${TH} w-1/3`}>Share</th>
                      <th scope="col" className={TH}>Devices</th>
                      {canManage && <th scope="col" className={TH}>Value</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.ageing.map((b) => (
                      <tr key={b.key} className="border-t border-neutral-200">
                        <th scope="row" className={`${TD} font-normal`}>
                          {b.key}
                        </th>
                        <td className={TD}>
                          <Bar value={b.count} max={maxAgeing} />
                        </td>
                        <td className={`${TD} tabular-nums`}>{b.count}</td>
                        {canManage && <td className={`${TD} tabular-nums`}>{money(b.value)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>

              <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                <h3 className="text-sm font-medium text-neutral-950">Slow-moving stock</h3>
                <p className="mt-1 text-sm text-neutral-700">
                  <strong className="tabular-nums">{data.slowMoving.count}</strong> device
                  {data.slowMoving.count === 1 ? '' : 's'} held longer than{' '}
                  {data.slowMoving.thresholdDays} days
                  {canManage && data.slowMoving.value != null
                    ? ` · ${money(data.slowMoving.value)} tied up`
                    : ''}
                  .
                </p>
                {/* Named for what it measures. The warehouse records no
                    per-device last-touched time, so "hasn't moved" would be a
                    claim the data cannot support. */}
                <p className="mt-1 text-xs text-neutral-600">
                  Measured from the booking-in date, not from the last time the device was touched.
                </p>
                {data.slowMoving.count > 0 && (
                  <p className="mt-2 text-sm">
                    <RowLink
                      href="/assets"
                      action="View devices"
                      context="held longer than 180 days"
                    />
                  </p>
                )}
              </div>
            </Section>

            <Section
              id="incoming"
              title="Incoming inventory"
              description="Purchase lots bought but not yet received."
            >
              <MetricGrid cols={2}>
                <Tile label="Expected today" value={data.incoming.expectedToday} href="/batches?filter=incoming" />
                <Tile label="Expected this week" value={data.incoming.expectedThisWeek} href="/batches?filter=incoming" />
                <Tile
                  label="Awaiting receipt"
                  value={data.incoming.awaitingReceiptLots}
                  sub={`${data.incoming.awaitingReceiptUnits} units expected`}
                  href="/batches?filter=incoming"
                />
                <Tile
                  label="Overdue"
                  value={data.incoming.overdue}
                  href="/batches?filter=overdue"
                  emphasis={data.incoming.overdue > 0 ? 'critical' : undefined}
                />
              </MetricGrid>
              {data.incoming.noDatePromised > 0 && (
                <p className="mt-3 text-sm text-neutral-600">
                  {data.incoming.noDatePromised} lot
                  {data.incoming.noDatePromised === 1 ? ' has' : 's have'} no expected arrival date,
                  so {data.incoming.noDatePromised === 1 ? 'it is' : 'they are'} counted as awaiting
                  receipt but can never show as overdue. Set a date on the lot to include{' '}
                  {data.incoming.noDatePromised === 1 ? 'it' : 'them'}.
                </p>
              )}
            </Section>
          </div>

          <div className="grid min-w-0 gap-x-4 lg:grid-cols-2">
            <Section
              id="health"
              title="Inventory health"
              description="Every condition below is a real count, not a score. The overall word is whichever of these is worst."
            >
              <TableScroll label="Inventory health conditions">
                <table className="w-full border-collapse">
                  <caption className="sr-only">
                    Each health condition, how many items it affects, and whether it is clear
                  </caption>
                  <thead className="bg-neutral-50">
                    <tr>
                      <th scope="col" className={TH}>Condition</th>
                      <th scope="col" className={TH}>Items</th>
                      <th scope="col" className={TH}>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.conditions.map((c) => (
                      <tr key={c.key} className="border-t border-neutral-200">
                        <th scope="row" className={`${TD} font-normal`}>
                          {c.label}
                        </th>
                        <td className={`${TD} tabular-nums`}>{c.count}</td>
                        <td className={TD}>
                          {c.ok ? <OkBadge /> : <SeverityBadge severity={c.severity} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </Section>

            <Section
              id="activity"
              title="Recent activity"
              action={
                canManage ? (
                  <Link href="/activity" className="text-sm font-medium text-[#1a6ef5] hover:underline">
                    View all activity
                  </Link>
                ) : undefined
              }
            >
              {data.activity.length === 0 ? (
                <Empty>Nothing has been recorded yet.</Empty>
              ) : (
                <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200">
                  {data.activity.map((a) => (
                    <li key={a.id} className="px-4 py-3">
                      <p className="text-sm text-neutral-950">{a.summary}</p>
                      <p className="mt-0.5 text-xs text-neutral-600">
                        {a.user ?? 'System'} ·{' '}
                        <time dateTime={a.at}>
                          {new Date(a.at).toLocaleString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: 'UTC',
                          })}
                        </time>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </div>
      </main>
  </>
  );
}
