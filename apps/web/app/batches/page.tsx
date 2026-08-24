import Link from 'next/link';
import { Plus, Target } from 'lucide-react';
import { apiFetch, getSessionAccess, getSessionUser } from '@/lib/api-server';
import { hasPermission } from '@/lib/permissions';
import type { Batch } from '@/lib/actions/batches';
import type { AuditTarget } from '@/lib/actions/devices';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';
import { GoodsInWorkspace } from './goods-in-workspace';

// `filter` narrows the list for the dashboard's Attention Required and Incoming
// links. Every one is computed from the lots themselves rather than from a
// status someone remembered to set — 'reconciled' in particular is a hand-picked
// dropdown value that no code ever writes, so trusting it would report progress
// nobody made.
type LotFilter = 'discrepancy' | 'overdue' | 'incoming';

const FILTER_COPY: Record<LotFilter, { title: string; blurb: string; empty: string }> = {
  discrepancy: {
    title: 'Lots with a stock discrepancy',
    blurb: 'The number of devices scanned in does not match the supplier manifest.',
    empty: 'Every lot with a manifest matches the devices scanned into it.',
  },
  overdue: {
    title: 'Overdue deliveries',
    blurb: 'Expected arrival date has passed and the goods have not been received.',
    empty: 'Nothing is overdue.',
  },
  incoming: {
    title: 'Incoming lots',
    blurb: 'Bought and expected, not yet being received.',
    empty: 'Nothing is currently on its way.',
  },
};

const NOT_YET_RECEIVED = ['draft', 'awaiting_arrival', 'open'];

function applyFilter(lots: Batch[], filter: LotFilter | null): Batch[] {
  if (!filter) return lots;
  const today = new Date().toISOString().slice(0, 10);
  if (filter === 'discrepancy') {
    return lots.filter(
      (l) =>
        l.expectedUnitCount != null &&
        l.status !== 'draft' &&
        l.expectedUnitCount !== l.actualUnitCount,
    );
  }
  if (filter === 'overdue') {
    return lots.filter(
      (l) =>
        NOT_YET_RECEIVED.includes(l.status) &&
        l.expectedArrivalDate != null &&
        l.expectedArrivalDate < today,
    );
  }
  return lots.filter((l) => NOT_YET_RECEIVED.includes(l.status));
}

export default async function LotsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: rawFilter } = await searchParams;
  const filter: LotFilter | null =
    rawFilter === 'discrepancy' || rawFilter === 'overdue' || rawFilter === 'incoming'
      ? rawFilter
      : null;
  const [allLots, user, sessionUser, auditTarget] = await Promise.all([
    apiFetch<Batch[]>('/batches'),
    getSessionAccess(),
    getSessionUser(),
    apiFetch<AuditTarget | null>('/devices/audit-target').catch(() => null),
  ]);
  // Derived from the same permissions the API enforces, so the buttons on this
  // page can never promise what a request would 403. Populations are identical
  // to the old role checks (create_batch: all roles; delete_batch: admin).
  const canCreate = hasPermission(user, 'create_batch');
  const canDelete = hasPermission(user, 'delete_batch');
  const canMove = hasPermission(user, 'move_to_pallet');
  const lots = applyFilter(allLots, filter);
  const copy = filter ? FILTER_COPY[filter] : null;

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
        <Breadcrumbs items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Goods In' }]} />

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4 sm:gap-6">
          <div className="min-w-0 max-w-3xl">
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-950">
              {copy ? copy.title : 'Goods In'}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-600">
              {copy
                ? copy.blurb
                : 'Operational workspace — receive, scan, audit and monitor each incoming lot. Select a lot to see its devices and their captured hardware, or open it to reconcile.'}
            </p>
            {copy && (
              <p className="mt-2 text-sm">
                <span className="text-neutral-700">
                  {lots.length} of {allLots.length} lots ·{' '}
                </span>
                <Link href="/batches" className="font-medium text-[#1a6ef5] hover:underline">
                  Show all lots
                </Link>
              </p>
            )}
          </div>
          {canCreate && (
            <Link
              href="/batches/new"
              className="flex shrink-0 items-center gap-2 rounded-md bg-[#1a6ef5] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white transition-colors hover:bg-blue-600"
            >
              <Plus className="size-4" aria-hidden="true" />
              New Lot
            </Link>
          )}
        </div>

        {/* Where the USB capture tool files its audits. Stated plainly rather
            than as a coloured banner: it is a setting a reader needs to be able
            to check at a glance, and the whole line is load-bearing, so none of
            it sits on low-contrast grey. */}
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-[#2b7fff]">
            <Target className="size-4" aria-hidden="true" />
          </span>
          <p className="text-sm leading-6 text-neutral-600">
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">
              Hardware audit target
            </span>
            <span className="mx-2" aria-hidden="true">
              ·
            </span>
            {auditTarget ? (
              <span className="font-semibold text-neutral-950">{auditTarget.batchNumber}</span>
            ) : (
              <span className="font-medium text-neutral-700">
                none selected — set one on a lot below
              </span>
            )}
            <span className="ml-2">— the capture tool files audits into this lot</span>
          </p>
        </div>

        {copy && lots.length === 0 ? (
          <p className="mt-4 rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
            {copy.empty}
          </p>
        ) : (
        <GoodsInWorkspace
          lots={lots}
          canExport={canCreate}
          canMove={canMove}
          canDelete={canDelete}
          activeAuditLotId={auditTarget?.batchId ?? null}
          viewer={sessionUser?.email ?? sessionUser?.role ?? 'signed in'}
        />
        )}
        </div>
      </main>
  </>
  );
}
