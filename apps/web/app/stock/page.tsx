import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { StockLine, StockStatus } from '@/lib/actions/stock';
import { Nav } from '@/app/components/nav';
import { StockStatusBadge } from './stock-status-badge';

const TH =
  'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500';
const TD = 'px-4 py-3 text-left text-sm';

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

  // Computed over `all`, never over the filtered view: the strip describes the
  // whole shelf and the filter narrows the list below it. A summary that shrank
  // when you filtered would be answering a different question each time.
  //
  // `all` is already narrowed by the search box (the API does that), so with a
  // search active these describe the matches — which is why the strip says so.
  const counts = {
    items: all.length,
    units: all.reduce((n, l) => n + (l.quantity ?? 0), 0),
    low: all.filter((l) => l.status === 'low_stock').length,
    out: all.filter((l) => l.status === 'out_of_stock').length,
  };

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Consumables</h1>
            {/* The count moved to the table footer, where every other list in
                the app states it — two "Showing N of M" lines on one page said
                the same thing twice. */}
            <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
              Bulk stock counted by SKU — cables, chargers, packaging. Serialised devices
              live on the Assets register.
            </p>
          </div>
          {canCreate && (
            <Link
              href="/stock/new"
              className="rounded-md bg-[#1a6ef5] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white hover:bg-blue-600"
            >
              New item
            </Link>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-neutral-200 bg-neutral-200 sm:grid-cols-4">
          <div className="bg-white p-4">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500">
              {search ? 'Items matching' : 'Items'}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{counts.items}</div>
            <div className="mt-0.5 text-xs text-neutral-600">Stock lines</div>
          </div>
          <div className="bg-white p-4">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500">Units on hand</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {counts.units.toLocaleString('en-GB')}
            </div>
            <div className="mt-0.5 text-xs text-neutral-600">Across every line</div>
          </div>
          <Link
            href="/stock?status=low_stock"
            className="bg-white p-4 transition-colors hover:bg-neutral-50"
          >
            <div className="text-[11px] uppercase tracking-wide text-neutral-500">Low stock</div>
            <div
              className={
                'mt-1 text-2xl font-semibold tabular-nums ' +
                (counts.low > 0 ? 'text-amber-700' : '')
              }
            >
              {counts.low}
            </div>
            <div className="mt-0.5 text-xs text-neutral-600">Below 10 on hand</div>
          </Link>
          <Link
            href="/stock?status=out_of_stock"
            className="bg-white p-4 transition-colors hover:bg-neutral-50"
          >
            <div className="text-[11px] uppercase tracking-wide text-neutral-500">Out of stock</div>
            <div
              className={
                'mt-1 text-2xl font-semibold tabular-nums ' +
                (counts.out > 0 ? 'text-red-700' : '')
              }
            >
              {counts.out}
            </div>
            <div className="mt-0.5 text-xs text-neutral-600">Nothing on hand</div>
          </Link>
        </div>

        <form
          action="/stock"
          className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-white p-3"
        >
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
          className="mt-4 overflow-x-auto rounded-xl border border-neutral-200 bg-white"
        >
          <table className="w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">
              Consumable stock lines with SKU, category, location, quantity on hand and status
            </caption>
            <thead className="bg-neutral-50">
              <tr>
                <th scope="col" className={TH}>Item</th>
                <th scope="col" className={TH}>SKU</th>
                <th scope="col" className={TH}>Category</th>
                <th scope="col" className={TH}>Location</th>
                <th scope="col" className={TH}>On hand</th>
                <th scope="col" className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr
                  key={s.id}
                  className="border-t border-neutral-200 transition-colors hover:bg-neutral-50"
                >
                  <th scope="row" className={`${TD} font-medium`}>
                    <Link href={`/stock/${s.id}`} className="text-[#1a6ef5] hover:underline">
                      {s.name}
                    </Link>
                  </th>
                  <td className={`${TD} text-neutral-600`}>{s.sku ?? '—'}</td>
                  <td className={`${TD} text-neutral-600`}>{s.category ?? '—'}</td>
                  <td className={`${TD} text-neutral-600`}>{s.location?.name ?? '—'}</td>
                  <td className={`${TD} font-medium tabular-nums`}>{s.quantity}</td>
                  <td className={TD}>
                    <StockStatusBadge status={s.status} />
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-neutral-600">
                    {active
                      ? `No consumables are ${filterLabel?.toLowerCase()}.`
                      : 'No consumables yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {items.length > 0 && (
          <p className="mt-3 text-xs text-neutral-600">
            Showing{' '}
            <span className="font-medium text-neutral-900 tabular-nums">{items.length}</span>
            {items.length !== all.length && (
              <>
                {' of '}
                <span className="font-medium text-neutral-900 tabular-nums">{all.length}</span>
              </>
            )}{' '}
            {items.length === 1 ? 'line' : 'lines'}
            {filterLabel ? ` · ${filterLabel} only` : ''}
            {search ? ` · matching “${search}”` : ''}
          </p>
        )}
        </div>
      </main>
  </>
  );
}
