import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Batch } from '@/lib/actions/batches';
import type { AuditTarget } from '@/lib/actions/devices';
import { Nav } from '@/app/components/nav';
import { LotsAccordion } from './lots-accordion';

export default async function LotsPage() {
  const [lots, user, auditTarget] = await Promise.all([
    apiFetch<Batch[]>('/batches'),
    getSessionUser(),
    apiFetch<AuditTarget | null>('/devices/audit-target').catch(() => null),
  ]);
  const canCreate = user?.role === 'admin' || user?.role === 'manager';

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Lots</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Operational workspace — receive, scan, audit and monitor each incoming lot. Expand a
              lot to see its devices, or open it to reconcile.
            </p>
          </div>
          {canCreate && (
            <Link
              href="/batches/new"
              className="shrink-0 rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
            >
              New Lot
            </Link>
          )}
        </div>

        <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-2.5 text-sm">
          <span className="text-neutral-500">Hardware audit target: </span>
          {auditTarget ? (
            <span className="font-medium text-emerald-400">{auditTarget.batchNumber}</span>
          ) : (
            <span className="text-neutral-500">none selected — set one on a lot below</span>
          )}
          <span className="ml-2 text-xs text-neutral-600">
            the capture tool files audits into this lot
          </span>
        </div>

        <LotsAccordion
          lots={lots}
          canExport={canCreate}
          activeAuditLotId={auditTarget?.batchId ?? null}
        />
      </div>
    </main>
  );
}
