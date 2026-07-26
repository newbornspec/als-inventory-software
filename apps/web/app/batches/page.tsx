import Link from 'next/link';
import { ChevronRight, Plus, Target } from 'lucide-react';
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
  const canCreate =
    user?.role === 'admin' || user?.role === 'manager' || user?.role === 'technician';

  return (
    <main className="min-h-screen bg-white text-neutral-950">
      <Nav />
      <div className="p-8">
        <div className="flex items-center gap-2 text-sm leading-5 text-neutral-500">
          <Link href="/dashboard" className="transition-colors hover:text-neutral-900">
            Dashboard
          </Link>
          <ChevronRight className="size-4" />
          <span className="font-medium text-neutral-950">Lots</span>
        </div>

        <div className="mt-8 flex items-start justify-between gap-6">
          <div className="max-w-3xl">
            <h1 className="text-4xl leading-10 font-semibold tracking-tight text-neutral-950">
              Lots
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-500">
              Operational workspace — receive, scan, audit and monitor each incoming lot. Expand a
              lot to see its devices, or open it to reconcile.
            </p>
          </div>
          {canCreate && (
            <Link
              href="/batches/new"
              className="flex shrink-0 items-center gap-2 rounded-xl bg-[#2b7fff] px-4 py-2 text-sm leading-5 font-medium text-white shadow-sm shadow-blue-500/15 transition-colors hover:bg-blue-600"
            >
              <Plus className="size-4" />
              New Lot
            </Link>
          )}
        </div>

        <div className="mt-8 rounded-2xl border border-blue-100 bg-blue-50/70 px-5 py-4 text-sm leading-5 text-neutral-950 shadow-[0_8px_24px_rgba(59,130,246,0.06)]">
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#2b7fff]/10 text-[#2b7fff]">
              <Target className="size-4" />
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
              <span className="ml-2 text-neutral-400">
                — the capture tool files audits into this lot
              </span>
            </p>
          </div>
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
