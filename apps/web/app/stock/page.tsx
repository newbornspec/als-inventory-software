import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { StockLine } from '@/lib/actions/stock';
import { Nav } from '@/app/components/nav';
import { StockStatusBadge } from './stock-status-badge';

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const { search } = await searchParams;
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  const [items, user] = await Promise.all([
    apiFetch<StockLine[]>(`/stock${qs}`),
    getSessionUser(),
  ]);
  const canCreate = user?.role === 'admin' || user?.role === 'manager';

  return (
    <main className="min-h-screen bg-white text-neutral-950">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Consumables</h1>
          {canCreate && (
            <Link
              href="/stock/new"
              className="rounded-md bg-[#2b7fff] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white"
            >
              New Item
            </Link>
          )}
        </div>

        <form action="/stock" className="mt-4 max-w-sm">
          <input
            name="search"
            defaultValue={search ?? ''}
            placeholder="Search name, SKU, category…"
            className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-300"
          />
        </form>

        <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-neutral-500">
              <tr>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">SKU</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">On hand</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t border-neutral-200 hover:bg-white">
                  <td className="px-4 py-3">
                    <Link href={`/stock/${s.id}`} className="text-neutral-950 underline">
                      {s.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-neutral-500">{s.sku ?? '—'}</td>
                  <td className="px-4 py-3 text-neutral-500">{s.category ?? '—'}</td>
                  <td className="px-4 py-3 text-neutral-500">{s.location?.name ?? '—'}</td>
                  <td className="px-4 py-3 font-medium">{s.quantity}</td>
                  <td className="px-4 py-3">
                    <StockStatusBadge status={s.status} />
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-neutral-500">
                    No consumables yet.
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
