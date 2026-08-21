import Link from 'next/link';
import { ChevronRight, Plus, Target } from 'lucide-react';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Batch } from '@/lib/actions/batches';
import type { AuditTarget } from '@/lib/actions/devices';
import { Nav } from '@/app/components/nav';
import { LotsAccordion } from './lots-accordion';

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
  const [allLots, user, auditTarget] = await Promise.all([
    apiFetch<Batch[]>('/batches'),
    getSessionUser(),
    apiFetch<AuditTarget | null>('/devices/audit-target').catch(() => null),
  ]);
  const canCreate =
    user?.role === 'admin' || user?.role === 'manager' || user?.role === 'technician';
  // Deleting a lot removes its devices and their audit trail with it, so it stays
  // admin-only — narrower than canCreate.
  const canDelete = user?.role === 'admin';
  const lots = applyFilter(allLots, filter);
  const copy = filter ? FILTER_COPY[filter] : null;

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <div className="flex items-center gap-2 text-sm leading-5 text-neutral-500">
          <Link href="/dashboard" className="transition-colors hover:text-neutral-900">
            Dashboard
          </Link>
          <ChevronRight className="size-4" aria-hidden="true" />
          <span className="font-medium text-neutral-950">Goods In</span>
        </div>

        <div className="mt-8 flex flex-wrap items-start justify-between gap-4 sm:gap-6">
          <div className="min-w-0 max-w-3xl">
            <h1 className="text-3xl leading-9 font-semibold tracking-tight text-neutral-950 sm:text-4xl sm:leading-10">
              {copy ? copy.title : 'Goods In'}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-600">
              {copy
                ? copy.blurb
                : 'Operational workspace — receive, scan, audit and monitor each incoming lot. Expand a lot to see its devices, or open it to reconcile.'}
            </p>
            {copy && (
              <p className="mt-2 text-sm">
                <span className="text-neutral-700">
                  {lots.length} of {allLots.length} lots ·{' '}
                </span>
                <Link href="/batches" className="font-medium text-blue-800 hover:underline">
                  Show all lots
                </Link>
              </p>
            )}
          </div>
          {canCreate && (
            <Link
              href="/batches/new"
              className="flex shrink-0 items-center gap-2 rounded-xl bg-[#1a6ef5] px-4 py-2 text-sm leading-5 font-medium text-white shadow-sm shadow-blue-500/15 transition-colors hover:bg-blue-600"
            >
              <Plus className="size-4" aria-hidden="true" />
              New Lot
            </Link>
          )}
        </div>

        <div className="mt-8 rounded-2xl border border-blue-100 bg-blue-50/70 px-5 py-4 text-sm leading-5 text-neutral-950 shadow-[0_8px_24px_rgba(59,130,246,0.06)]">
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#1a6ef5]/10 text-[#2b7fff]">
              <Target className="size-4" aria-hidden="true" />
            </div>
            <p className="leading-6 text-neutral-500">
              Hardware audit target:{' '}
              {auditTarget ? (
                <span className="font-semibold text-neutral-950">{auditTarget.batchNumber}</span>
              ) : (
                <span className="font-medium text-neutral-500">
                  none selected — set one on a lot below
                </span>
              )}
              <span className="ml-2 text-neutral-600">
                — the capture tool files audits into this lot
              </span>
            </p>
          </div>
        </div>

        {copy && lots.length === 0 ? (
          <p className="mt-8 rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
            {copy.empty}
          </p>
        ) : (
        <LotsAccordion
          lots={lots}
          canExport={canCreate}
          canDelete={canDelete}
          activeAuditLotId={auditTarget?.batchId ?? null}
        />
        )}
      </main>
  </>
  );
}
