import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Batch } from '@/lib/actions/batches';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';

export default async function BatchesPage() {
  const [batches, user] = await Promise.all([
    apiFetch<Batch[]>('/batches'),
    getSessionUser(),
  ]);
  const canCreate = user?.role === 'admin' || user?.role === 'manager';

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Purchase Lots</h1>
          {canCreate && (
            <Link
              href="/batches/new"
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
            >
              New Purchase Lot
            </Link>
          )}
        </div>

        <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-4 py-3">Lot #</th>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Units (actual / expected)</th>
                <th className="px-4 py-3">Location</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => {
                const short = batch.expectedUnitCount != null && batch.actualUnitCount < batch.expectedUnitCount;
                const over = batch.expectedUnitCount != null && batch.actualUnitCount > batch.expectedUnitCount;
                return (
                  <tr key={batch.id} className="border-t border-neutral-800 hover:bg-neutral-900">
                    <td className="px-4 py-3">
                      <Link href={`/batches/${batch.id}`} className="text-neutral-100 underline">
                        {batch.batchNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-neutral-400">{batch.source ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs">
                        {formatLabel(batch.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={short ? 'text-amber-400' : over ? 'text-red-400' : 'text-neutral-300'}>
                        {batch.actualUnitCount}
                      </span>
                      {' / '}
                      {batch.expectedUnitCount ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">{batch.location?.name ?? '—'}</td>
                  </tr>
                );
              })}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-neutral-500">
                    No purchase lots yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
