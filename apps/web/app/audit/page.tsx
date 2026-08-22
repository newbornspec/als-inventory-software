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
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <Breadcrumbs items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Audit' }]} />
        <h1 className="mt-3 text-2xl font-semibold">Audit</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-500">
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
          <p className="mt-6 text-sm text-neutral-500">
            {kind ? 'No audits match this filter yet.' : 'No audits recorded yet.'}
          </p>
        ) : (
          <AuditDays days={days} kind={kind} />
        )}
      </main>
    </>
  );
}
