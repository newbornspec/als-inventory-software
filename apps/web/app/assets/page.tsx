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
    // Dashboard deep links. Kept as string flags to match the API, where
    // locationId must be a UUID so "has none" needs a parameter of its own.
    locationId?: string;
    noLocation?: string;
    noAudit?: string;
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
      params.category ||
      params.locationId ||
      params.noLocation === 'true' ||
      params.noAudit === 'true',
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
    if (params.locationId) query.set('locationId', params.locationId);
    if (params.noLocation === 'true') query.set('noLocation', 'true');
    if (params.noAudit === 'true') query.set('noAudit', 'true');
    flat = await apiFetch<Asset[]>(`/assets?${query.toString()}`);
  } else {
    [batches, unassigned] = await Promise.all([
      apiFetch<Batch[]>('/batches'),
      apiFetch<Asset[]>('/assets?noBatch=true'),
    ]);
  }

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Assets</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Serialized devices only, grouped by their lot — expand a lot to see its units, or
              search to jump straight to one. For pallet stock and consumables, see{' '}
              <Link href="/inventory" className="text-neutral-700 underline hover:text-neutral-950">
                All Inventory
              </Link>
              .
            </p>
          </div>
          {canCreate && (
            <Link
              href="/assets/new"
              className="shrink-0 rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white"
            >
              New Asset
            </Link>
          )}
        </div>

        <form className="mt-6 flex flex-wrap gap-3" action="/assets">
          {params.locationId && <input type="hidden" name="locationId" value={params.locationId} />}
          {params.noLocation === 'true' && <input type="hidden" name="noLocation" value="true" />}
          {params.noAudit === 'true' && <input type="hidden" name="noAudit" value="true" />}
          <label htmlFor="assets-search" className="sr-only">
            Search by tag, serial or name
          </label>
          <input
            id="assets-search"
            name="search"
            defaultValue={params.search}
            placeholder="Search by tag, serial or name…"
            className="w-full min-w-0 flex-1 rounded-md sm:w-auto sm:min-w-[18rem] border border-[var(--field-border)] bg-white px-3 py-2 text-sm focus:border-[var(--field-border)]"
          />
          <label htmlFor="assets-stock-status" className="sr-only">
            Stock status
          </label>
          <select
            id="assets-stock-status"
            name="stockStatus"
            defaultValue={params.stockStatus ?? ''}
            className="rounded-md border border-[var(--field-border)] bg-white px-3 py-2 text-sm"
          >
            <option value="">All stock statuses</option>
            {STOCK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {formatLabel(s)}
              </option>
            ))}
          </select>
          <label htmlFor="assets-grade" className="sr-only">
            Condition grade
          </label>
          <select
            id="assets-grade"
            name="conditionGrade"
            defaultValue={params.conditionGrade ?? ''}
            className="rounded-md border border-[var(--field-border)] bg-white px-3 py-2 text-sm"
          >
            <option value="">All condition grades</option>
            {CONDITION_GRADES.map((g) => (
              <option key={g} value={g}>
                {formatLabel(g)}
              </option>
            ))}
          </select>
          <label htmlFor="assets-audit-status" className="sr-only">
            Audit status
          </label>
          <select
            id="assets-audit-status"
            name="auditStatus"
            defaultValue={params.auditStatus ?? ''}
            className="rounded-md border border-[var(--field-border)] bg-white px-3 py-2 text-sm"
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
            className="rounded-md border border-[var(--field-border)] px-4 py-2 text-sm text-neutral-700"
          >
            Filter
          </button>
          {isSearching && (
            <Link
              href="/assets"
              className="rounded-md px-4 py-2 text-sm text-neutral-500 hover:text-neutral-700"
            >
              Clear
            </Link>
          )}
        </form>

        {isSearching ? (
          <div role="region" aria-label="Devices" tabIndex={0} className="mt-6 overflow-x-auto rounded-lg border border-neutral-200">
            <table className="w-full text-left text-sm">
          <caption className="sr-only">Devices matching the current search and filters</caption>
              <thead className="bg-neutral-50 text-neutral-500">
                <tr>
                  <th scope="col" className="px-4 py-3">Name</th>
                  <th scope="col" className="px-4 py-3">Category</th>
                  <th scope="col" className="px-4 py-3">Stock Status</th>
                  <th scope="col" className="px-4 py-3">Grade</th>
                  <th scope="col" className="px-4 py-3">Audit Status</th>
                  <th scope="col" className="px-4 py-3">Location</th>
                </tr>
              </thead>
              <tbody>
                {flat.map((asset) => (
                  <tr key={asset.id} className="border-t border-neutral-200 hover:bg-white">
                    <td className="px-4 py-3">
                      <Link href={`/assets/${asset.id}`} className="text-neutral-950 underline">
                        {asset.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-neutral-500">{asset.category}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs">
                        {formatLabel(asset.stockStatus)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {asset.conditionGrade ? formatLabel(asset.conditionGrade) : '—'}
                    </td>
                    <td className="px-4 py-3 text-neutral-500">
                      {asset.auditStatus ? formatLabel(asset.auditStatus) : '—'}
                    </td>
                    <td className="px-4 py-3 text-neutral-500">{asset.location?.name ?? '—'}</td>
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
      </main>
  </>
  );
}
