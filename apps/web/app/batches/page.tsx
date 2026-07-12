import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Batch } from '@/lib/actions/batches';
import { Nav } from '@/app/components/nav';
import { LotsAccordion } from './lots-accordion';

export default async function LotsPage() {
  const [lots, user] = await Promise.all([apiFetch<Batch[]>('/batches'), getSessionUser()]);
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

        <LotsAccordion lots={lots} />
      </div>
    </main>
  );
}
