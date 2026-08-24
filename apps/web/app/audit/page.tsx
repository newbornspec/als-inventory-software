import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiFetch, getSessionAccess } from '@/lib/api-server';
import { hasPermission, landingFor } from '@/lib/permissions';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';
import { AuditDays, type AuditDaySummary } from './audit-days';

// The Audit workspace: a chronological, day-grouped feed of audit activity
// across every device — deliberately NOT the Goods In batch-card shape.
// Audits belong to the device (one asset_audits row per EVENT, re-audited
// over its life), so the drill-down here is day -> device -> events, and a
// device is reached through itself, never through the lot it arrived in.
const KIND_FILTERS = [
  { value: '', label: 'All' },
  { value: 'amazon', label: 'Amazon' },
  { value: 'goods_in', label: 'Goods In' },
  // Events recorded before workflows were marked, or by a USB stick that
  // predates the marker. Honest bucket, never guessed into the other two.
  { value: 'unclassified', label: 'Unclassified' },
];

// A strip over the days already on screen, so the reader is not left adding up
// seven rows to learn how much was audited.
//
// The wording is doing real work here. Summing each day's device count gives
// DEVICE-DAYS, not distinct devices: a machine re-audited on Tuesday and Friday
// contributes twice. The API's day summary carries no distinct-device figure,
// so rather than print a number that is quietly wrong, the tile is labelled for
// what it actually counts and states the rule underneath.
function AuditSummary({ days }: { days: AuditDaySummary[] }) {
  const events = days.reduce((n, d) => n + d.events, 0);
  const deviceDays = days.reduce((n, d) => n + d.devices, 0);
  const busiest = days.reduce((best, d) => (d.devices > best.devices ? d : best), days[0]);
  const N = (n: number) => n.toLocaleString('en-GB');
  const cells: { label: string; value: string; sub: string }[] = [
    { label: 'Days with activity', value: N(days.length), sub: 'In the window shown' },
    { label: 'Device audits', value: N(deviceDays), sub: 'Counted once per device per day' },
    { label: 'Audit events', value: N(events), sub: 'Every recorded event' },
    {
      label: 'Busiest day',
      value: N(busiest.devices),
      sub: new Date(busiest.day).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    },
  ];
  return (
    <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-neutral-200 bg-neutral-200 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="bg-white p-4">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">{c.label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{c.value}</div>
          <div className="mt-0.5 text-xs text-neutral-600">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const access = await getSessionAccess();
  if (!access || !hasPermission(access, 'amazon_audit')) redirect(landingFor(access));

  const { kind: rawKind } = await searchParams;
  const kind = KIND_FILTERS.some((f) => f.value === rawKind) ? (rawKind ?? '') : '';
  const qs = kind ? `&kind=${kind}` : '';
  const days = await apiFetch<AuditDaySummary[]>(`/audits/days?limit=60${qs}`).catch(
    () => [] as AuditDaySummary[],
  );

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
        <Breadcrumbs items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Audit' }]} />
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Audit</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
          Audit activity by day, newest first. A device is counted once per day however many
          events its session produced — expand it to see the full trail.
        </p>

        <nav aria-label="Filter by workflow" className="mt-4 flex flex-wrap gap-1.5">
          {KIND_FILTERS.map((f) => {
            const active = f.value === kind;
            return (
              <Link
                key={f.value || 'all'}
                href={f.value ? `/audit?kind=${f.value}` : '/audit'}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'rounded-full border border-neutral-900 bg-neutral-900 px-3 py-1 text-xs font-medium text-white'
                    : 'rounded-full border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100'
                }
              >
                {f.label}
              </Link>
            );
          })}
        </nav>

        {days.length === 0 ? (
          <p className="mt-4 rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
            {kind ? 'No audits match this filter yet.' : 'No audits recorded yet.'}
          </p>
        ) : (
          <>
            <AuditSummary days={days} />
            <AuditDays days={days} kind={kind} />
          </>
        )}
        </div>
      </main>
    </>
  );
}
