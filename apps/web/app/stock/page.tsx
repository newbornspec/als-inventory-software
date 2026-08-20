import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { StockLine, StockStatus } from '@/lib/actions/stock';
import { Nav } from '@/app/components/nav';
import { StockStatusBadge } from './stock-status-badge';

const STATUS_LABELS: Record<StockStatus, string> = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
};

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; status?: string }>;
}) {
  const { search, status } = await searchParams;
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  const [all, user] = await Promise.all([
    apiFetch<StockLine[]>(`/stock${qs}`),
    getSessionUser(),
  ]);
  const canCreate = user?.role === 'admin' || user?.role === 'manager';

  // The status is derived from the quantity by the API, not stored, so there is
  // nothing to filter on server-side — narrowing here keeps the two definitions
  // from drifting apart. The dashboard's "Low stock 5 → View" lands on exactly
  // those five lines.
  const active = status === 'low_stock' || status === 'out_of_stock' || status === 'in_stock';
  const items = active ? all.filter((s) => s.status === status) : all;
  const filterLabel = active ? STATUS_LABELS[status as StockStatus] : null;

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Consumables</h1>
            {filterLabel && (
              <p className="mt-1 text-sm text-neutral-700">
                Showing <strong>{filterLabel}</strong> only · {items.length} of {all.length} items
              </p>
            )}
          </div>
          {canCreate && (
            <Link
              href="/stock/new"
              className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white"
            >
              New Item
            </Link>
          )}
        </div>

        <form action="/stock" className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 sm:max-w-sm">
            <label htmlFor="stock-search" className="block text-sm text-neutral-700">
              Search
            </label>
            <input
              id="stock-search"
              name="search"
              defaultValue={search ?? ''}
              placeholder="Name, SKU, category…"
              className="field-underline mt-1 w-full px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="stock-status" className="block text-sm text-neutral-700">
              Status
            </label>
            <select
              id="stock-status"
              name="status"
              defaultValue={active ? status : ''}
              className="field-underline mt-1 px-3 py-2 text-sm"
            >
              <option value="">All statuses</option>
              <option value="in_stock">In stock</option>
              <option value="low_stock">Low stock</option>
              <option value="out_of_stock">Out of stock</option>
            </select>
          </div>
          <button
            type="submit"
            className="rounded-md border border-[var(--control-border)] px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
          >
            Filter
          </button>
          {(active || search) && (
            <Link href="/stock" className="rounded-md px-3 py-2 text-sm text-neutral-700 hover:underline">
              Clear
            </Link>
          )}
        </form>

        <div
          role="region"
          aria-label="Consumables"
          tabIndex={0}
          className="mt-4 overflow-x-auto rounded-lg border border-neutral-200"
        >
          <table className="w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">
              Consumable stock lines with SKU, category, location, quantity on hand and status
            </caption>
            <thead className="bg-neutral-50 text-neutral-600">
              <tr>
                <th scope="col" className="px-4 py-3">Item</th>
                <th scope="col" className="px-4 py-3">SKU</th>
                <th scope="col" className="px-4 py-3">Category</th>
                <th scope="col" className="px-4 py-3">Location</th>
                <th scope="col" className="px-4 py-3">On hand</th>
                <th scope="col" className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t border-neutral-200 hover:bg-white">
                  <th scope="row" className="px-4 py-3 font-normal">
                    <Link href={`/stock/${s.id}`} className="text-blue-800 underline">
                      {s.name}
                    </Link>
                  </th>
                  <td className="px-4 py-3 text-neutral-600">{s.sku ?? '—'}</td>
                  <td className="px-4 py-3 text-neutral-600">{s.category ?? '—'}</td>
                  <td className="px-4 py-3 text-neutral-600">{s.location?.name ?? '—'}</td>
                  <td className="px-4 py-3 font-medium tabular-nums">{s.quantity}</td>
                  <td className="px-4 py-3">
                    <StockStatusBadge status={s.status} />
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-neutral-600">
                    {active
                      ? `No consumables are ${filterLabel?.toLowerCase()}.`
                      : 'No consumables yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
  </>
  );
}
