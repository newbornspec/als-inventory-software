import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { StockLine } from '@/lib/actions/stock';
import { Nav } from '@/app/components/nav';

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
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Consumables</h1>
          {canCreate && (
            <Link
              href="/stock/new"
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
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
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </form>

        <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">SKU</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">On hand</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t border-neutral-800 hover:bg-neutral-900">
                  <td className="px-4 py-3">
                    <Link href={`/stock/${s.id}`} className="text-neutral-100 underline">
                      {s.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-neutral-400">{s.sku ?? '—'}</td>
                  <td className="px-4 py-3 text-neutral-400">{s.category ?? '—'}</td>
                  <td className="px-4 py-3 text-neutral-400">{s.location?.name ?? '—'}</td>
                  <td
                    className={
                      'px-4 py-3 font-medium ' + (s.quantity === 0 ? 'text-amber-400' : '')
                    }
                  >
                    {s.quantity}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-neutral-500">
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
