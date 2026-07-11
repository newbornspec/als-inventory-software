import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Pallet } from '@/lib/actions/pallets';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';

export default async function PalletsPage() {
  const [pallets, user] = await Promise.all([apiFetch<Pallet[]>('/pallets'), getSessionUser()]);
  const canCreate = user?.role === 'admin' || user?.role === 'manager';

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Pallets</h1>
          {canCreate && (
            <Link
              href="/pallets/new"
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
            >
              New Pallet
            </Link>
          )}
        </div>

        <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-4 py-3">Pallet #</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Total units</th>
                <th className="px-4 py-3">Variants</th>
                <th className="px-4 py-3">Location</th>
              </tr>
            </thead>
            <tbody>
              {pallets.map((p) => (
                <tr key={p.id} className="border-t border-neutral-800 hover:bg-neutral-900">
                  <td className="px-4 py-3">
                    <Link href={`/pallets/${p.id}`} className="text-neutral-100 underline">
                      {p.palletNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-neutral-400">{p.description ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs">
                      {formatLabel(p.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">{p.totalQuantity}</td>
                  <td className="px-4 py-3 text-neutral-400">{p.lineCount}</td>
                  <td className="px-4 py-3 text-neutral-400">{p.location?.name ?? '—'}</td>
                </tr>
              ))}
              {pallets.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-neutral-500">
                    No pallets yet.
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
