import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Asset } from '@/lib/actions/assets';
import type { Batch } from '@/lib/actions/batches';
import { Nav } from '@/app/components/nav';
import { AUDIT_STATUSES, CONDITION_GRADES, STOCK_STATUSES, formatLabel } from '@/lib/asset-options';
import { AssetsGrouped } from './assets-grouped';

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string;
    stockStatus?: string;
    conditionGrade?: string;
    auditStatus?: string;
    category?: string;
  }>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  const canCreate = user?.role === 'admin' || user?.role === 'manager';

  // Any active search/filter flattens the view so you jump straight to devices;
  // otherwise browse grouped by lot.
  const isSearching = Boolean(
    params.search ||
      params.stockStatus ||
      params.conditionGrade ||
      params.auditStatus ||
      params.category,
  );

  let flat: Asset[] = [];
  let batches: Batch[] = [];
  let unassigned: Asset[] = [];

  if (isSearching) {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.stockStatus) query.set('stockStatus', params.stockStatus);
    if (params.conditionGrade) query.set('conditionGrade', params.conditionGrade);
    if (params.auditStatus) query.set('auditStatus', params.auditStatus);
    if (params.category) query.set('category', params.category);
    flat = await apiFetch<Asset[]>(`/assets?${query.toString()}`);
  } else {
    [batches, unassigned] = await Promise.all([
      apiFetch<Batch[]>('/batches'),
      apiFetch<Asset[]>('/assets?noBatch=true'),
    ]);
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Assets</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Serialized devices only, grouped by their lot — expand a lot to see its units, or
              search to jump straight to one. For pallet stock and consumables, see{' '}
              <Link href="/inventory" className="text-neutral-300 underline hover:text-neutral-100">
                All Inventory
              </Link>
              .
            </p>
          </div>
          {canCreate && (
            <Link
              href="/assets/new"
              className="shrink-0 rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
            >
              New Asset
            </Link>
          )}
        </div>

        <form className="mt-6 flex flex-wrap gap-3" action="/assets">
          <input
            name="search"
            defaultValue={params.search}
            placeholder="Search by tag, serial or name…"
            className="min-w-[18rem] flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
          <select
            name="stockStatus"
            defaultValue={params.stockStatus ?? ''}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          >
            <option value="">All stock statuses</option>
            {STOCK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {formatLabel(s)}
              </option>
            ))}
          </select>
          <select
            name="conditionGrade"
            defaultValue={params.conditionGrade ?? ''}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          >
            <option value="">All condition grades</option>
            {CONDITION_GRADES.map((g) => (
              <option key={g} value={g}>
                {formatLabel(g)}
              </option>
            ))}
          </select>
          <select
            name="auditStatus"
            defaultValue={params.auditStatus ?? ''}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          >
            <option value="">All audit statuses</option>
            {AUDIT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {formatLabel(s)}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300"
          >
            Filter
          </button>
          {isSearching && (
            <Link
              href="/assets"
              className="rounded-md px-4 py-2 text-sm text-neutral-500 hover:text-neutral-300"
            >
              Clear
            </Link>
          )}
        </form>

        {isSearching ? (
          <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Stock Status</th>
                  <th className="px-4 py-3">Grade</th>
                  <th className="px-4 py-3">Audit Status</th>
                  <th className="px-4 py-3">Location</th>
                </tr>
              </thead>
              <tbody>
                {flat.map((asset) => (
                  <tr key={asset.id} className="border-t border-neutral-800 hover:bg-neutral-900">
                    <td className="px-4 py-3">
                      <Link href={`/assets/${asset.id}`} className="text-neutral-100 underline">
                        {asset.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-neutral-400">{asset.category}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs">
                        {formatLabel(asset.stockStatus)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-400">
                      {asset.conditionGrade ? formatLabel(asset.conditionGrade) : '—'}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">
                      {asset.auditStatus ? formatLabel(asset.auditStatus) : '—'}
                    </td>
                    <td className="px-4 py-3 text-neutral-400">{asset.location?.name ?? '—'}</td>
                  </tr>
                ))}
                {flat.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-neutral-500">
                      No assets match this search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <AssetsGrouped batches={batches} unassigned={unassigned} />
        )}
      </div>
    </main>
  );
}
