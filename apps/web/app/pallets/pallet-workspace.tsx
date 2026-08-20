'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react';
import type { Pallet } from '@/lib/actions/pallets';
import { formatLabel } from '@/lib/asset-options';
import {
  applyFilters,
  countActiveFilters,
  DATE_PRESETS,
  EMPTY_FILTERS,
  layoutLabel,
  sortPallets,
  type DatePreset,
  type PalletFilterState,
  type SortDir,
  type SortKey,
} from './pallet-filters';

const FIELD = 'field-underline px-2 py-1.5 text-sm';
const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-600';
const TD = 'px-3 py-2 text-sm';

function created(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Sortable column header. aria-sort is what actually tells a screen reader which
// column is ordered and which way — the arrow is decoration.
function SortHeader({
  label,
  active,
  dir,
  onSort,
  className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onSort: () => void;
  className?: string;
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`${TH} ${className ?? ''}`}
    >
      <button
        onClick={onSort}
        className="inline-flex items-center gap-1 hover:text-neutral-900"
        aria-label={`Sort by ${label}${active ? (dir === 'asc' ? ', currently oldest first' : ', currently newest first') : ''}`}
      >
        {label}
        {active &&
          (dir === 'asc' ? (
            <ArrowUp className="size-3" aria-hidden="true" />
          ) : (
            <ArrowDown className="size-3" aria-hidden="true" />
          ))}
      </button>
    </th>
  );
}

export function PalletWorkspace({
  pallets,
  canManage,
}: {
  pallets: Pallet[];
  canManage: boolean;
}) {
  const [filters, setFilters] = useState<PalletFilterState>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>('created');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);

  const set = <K extends keyof PalletFilterState>(k: K, v: PalletFilterState[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  // Options come from the data, so a filter can never offer a value that
  // matches nothing.
  const { locations, suppliers, statuses } = useMemo(() => {
    const loc = new Map<string, string>();
    const sup = new Set<string>();
    const st = new Set<string>();
    for (const p of pallets) {
      if (p.location?.id) loc.set(p.location.id, p.location.name);
      if (p.supplier) sup.add(p.supplier);
      st.add(p.status);
    }
    return {
      locations: [...loc.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      suppliers: [...sup].sort(),
      statuses: [...st].sort(),
    };
  }, [pallets]);

  const visible = useMemo(
    () => sortPallets(applyFilters(pallets, filters), sortKey, sortDir),
    [pallets, filters, sortKey, sortDir],
  );

  const activeFilters = countActiveFilters(filters);
  const selectedList = visible.filter((p) => selected.has(p.id));
  const allVisibleSelected = visible.length > 0 && selectedList.length === visible.length;

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'created' ? 'desc' : 'asc');
    }
  }

  function toggleRow(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((s) => {
      if (allVisibleSelected) {
        const next = new Set(s);
        visible.forEach((p) => next.delete(p.id));
        return next;
      }
      return new Set([...s, ...visible.map((p) => p.id)]);
    });
  }

  const summary = useMemo(() => {
    const units = visible.reduce((n, p) => n + (p.totalQuantity ?? 0), 0);
    const locs = new Set(visible.map((p) => p.location?.id).filter(Boolean));
    const l1 = visible.filter((p) => (p.entryLayout ?? 'variant') === 'variant').length;
    const l2 = visible.filter((p) => p.entryLayout === 'spec').length;
    return { units, locs: locs.size, l1, l2 };
  }, [visible]);

  return (
    <div className="mt-6">
      {/* --- summary ------------------------------------------------------ */}
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-2xl font-semibold tabular-nums">{visible.length}</div>
          <div className="text-sm text-neutral-600">
            {activeFilters > 0 ? `of ${pallets.length} pallets` : 'pallets'}
          </div>
        </div>
        {[
          ['Total units', summary.units.toLocaleString('en-GB')],
          ['Locations', String(summary.locs)],
          ['Layout 1', String(summary.l1)],
          ['Layout 2', String(summary.l2)],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="text-lg font-semibold tabular-nums">{value}</div>
            <div className="text-xs text-neutral-600">{label}</div>
          </div>
        ))}
      </div>

      {/* --- search + filters --------------------------------------------- */}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 sm:max-w-md">
          <label htmlFor="pallet-search" className="block text-sm text-neutral-700">
            Search pallets
          </label>
          <input
            id="pallet-search"
            type="search"
            value={filters.search}
            onChange={(e) => set('search', e.target.value)}
            placeholder="Number, description, supplier, location…"
            className={`${FIELD} mt-1 w-full`}
          />
        </div>

        <button
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          aria-controls="pallet-filters"
          className="rounded-md border border-[var(--control-border)] px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
        >
          Filters{activeFilters > 0 ? ` (${activeFilters})` : ''}
        </button>

        {activeFilters > 0 && (
          <button
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="rounded-md px-3 py-2 text-sm text-neutral-700 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      <div
        id="pallet-filters"
        hidden={!showFilters}
        className="mt-3 grid gap-3 rounded-lg border border-neutral-200 p-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <div>
          <label htmlFor="f-created" className="block text-sm text-neutral-700">
            Created
          </label>
          <select
            id="f-created"
            value={filters.preset}
            onChange={(e) => set('preset', e.target.value as DatePreset)}
            className={`${FIELD} mt-1 w-full`}
          >
            {DATE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {filters.preset === 'custom' && (
          <>
            <div>
              <label htmlFor="f-from" className="block text-sm text-neutral-700">
                From
              </label>
              <input
                id="f-from"
                type="date"
                value={filters.from}
                onChange={(e) => set('from', e.target.value)}
                className={`${FIELD} mt-1 w-full`}
              />
            </div>
            <div>
              <label htmlFor="f-to" className="block text-sm text-neutral-700">
                To
              </label>
              <input
                id="f-to"
                type="date"
                value={filters.to}
                onChange={(e) => set('to', e.target.value)}
                className={`${FIELD} mt-1 w-full`}
              />
            </div>
          </>
        )}

        <div>
          <label htmlFor="f-layout" className="block text-sm text-neutral-700">
            Layout
          </label>
          <select
            id="f-layout"
            value={filters.layout}
            onChange={(e) => set('layout', e.target.value)}
            className={`${FIELD} mt-1 w-full`}
          >
            <option value="">All</option>
            <option value="variant">Layout 1</option>
            <option value="spec">Layout 2</option>
          </select>
        </div>

        <div>
          <label htmlFor="f-status" className="block text-sm text-neutral-700">
            Status
          </label>
          <select
            id="f-status"
            value={filters.status}
            onChange={(e) => set('status', e.target.value)}
            className={`${FIELD} mt-1 w-full`}
          >
            <option value="">All</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {formatLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="f-location" className="block text-sm text-neutral-700">
            Location
          </label>
          <select
            id="f-location"
            value={filters.location}
            onChange={(e) => set('location', e.target.value)}
            className={`${FIELD} mt-1 w-full`}
          >
            <option value="">All</option>
            {locations.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="f-supplier" className="block text-sm text-neutral-700">
            Supplier
          </label>
          <select
            id="f-supplier"
            value={filters.supplier}
            onChange={(e) => set('supplier', e.target.value)}
            className={`${FIELD} mt-1 w-full`}
          >
            <option value="">All</option>
            {suppliers.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* --- selection bar ------------------------------------------------
          Appears only when something is selected, and states the scope
          explicitly. The whole filtered set is on one page, so "select all"
          cannot mean something different from what is on screen — and it says
          so rather than leaving the user to assume. */}
      <div aria-live="polite" className="sr-only">
        {selectedList.length > 0 ? `${selectedList.length} pallets selected` : ''}
      </div>

      {selectedList.length > 0 && canManage && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-[#1a6ef5] bg-blue-50 px-4 py-3">
          <span className="text-sm font-medium text-neutral-950">
            {selectedList.length} pallet{selectedList.length === 1 ? '' : 's'} selected
            {activeFilters > 0 && allVisibleSelected ? ' — all matching the current filters' : ''}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {/* A real form POST, not a link: the selection can be every pallet
                in the list, and that many ids belongs in a body rather than in
                a URL. The response is an attachment, so the browser downloads
                it and leaves the page — and the selection — where it is. */}
            <form action="/api/pallets/export" method="POST">
              <input
                type="hidden"
                name="ids"
                value={selectedList.map((p) => p.id).join(',')}
              />
              <button
                type="submit"
                className="rounded-md bg-[#1a6ef5] px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
              >
                Export to Excel
              </button>
            </form>
            <button
              onClick={() => setSelected(new Set())}
              className="rounded-md border border-[var(--control-border)] px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-white"
            >
              Clear selection
            </button>
          </div>
        </div>
      )}

      {/* --- table --------------------------------------------------------- */}
      <div
        role="region"
        aria-label="Pallets"
        tabIndex={0}
        className="mt-4 overflow-x-auto rounded-lg border border-neutral-200"
      >
        <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            Pallets with creation date, layout, status, unit counts and location.
            {activeFilters > 0 ? ` Filtered: ${visible.length} of ${pallets.length}.` : ''}
          </caption>
          <thead className="bg-neutral-50">
            <tr>
              {canManage && (
                <th scope="col" className={`${TH} w-10`}>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      // Indeterminate is the honest state for a partial
                      // selection — neither checked nor empty.
                      if (el) el.indeterminate = selectedList.length > 0 && !allVisibleSelected;
                    }}
                    onChange={toggleAll}
                    aria-label={
                      allVisibleSelected
                        ? `Deselect all ${visible.length} pallets`
                        : `Select all ${visible.length} pallets shown`
                    }
                    className="size-4 accent-[#1a6ef5]"
                  />
                </th>
              )}
              <th scope="col" className={`${TH} w-8 sm:hidden`}>
                <span className="sr-only">Show details</span>
              </th>
              <SortHeader
                label="Pallet #"
                active={sortKey === 'palletNumber'}
                dir={sortDir}
                onSort={() => toggleSort('palletNumber')}
              />
              <SortHeader
                label="Created"
                active={sortKey === 'created'}
                dir={sortDir}
                onSort={() => toggleSort('created')}
              />
              <th scope="col" className={`${TH} hidden md:table-cell`}>Description</th>
              <th scope="col" className={TH}>Layout</th>
              <th scope="col" className={TH}>Status</th>
              <SortHeader
                label="Units"
                active={sortKey === 'units'}
                dir={sortDir}
                onSort={() => toggleSort('units')}
                className="hidden sm:table-cell"
              />
              <th scope="col" className={`${TH} hidden lg:table-cell`}>Variants</th>
              <th scope="col" className={`${TH} hidden lg:table-cell`}>Location</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const isSelected = selected.has(p.id);
              const isOpen = expanded.has(p.id);
              return (
                <Fragment key={p.id}>
                  <tr
                    // Selection is shown three ways, none of them colour alone:
                    // the checkbox itself, a left rule, and aria-selected.
                    aria-selected={isSelected}
                    className={
                      'border-t border-neutral-200 ' +
                      (isSelected ? 'border-l-4 border-l-[#1a6ef5] bg-blue-50/60' : '')
                    }
                  >
                    {canManage && (
                      <td className={TD}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(p.id)}
                          aria-label={`Select ${p.palletNumber}`}
                          className="size-4 accent-[#1a6ef5]"
                        />
                      </td>
                    )}
                    <td className={`${TD} sm:hidden`}>
                      <button
                        onClick={() =>
                          setExpanded((s) => {
                            const next = new Set(s);
                            if (next.has(p.id)) next.delete(p.id);
                            else next.add(p.id);
                            return next;
                          })
                        }
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${p.palletNumber}`}
                        className="text-neutral-600"
                      >
                        {isOpen ? (
                          <ChevronDown className="size-4" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="size-4" aria-hidden="true" />
                        )}
                      </button>
                    </td>
                    <th scope="row" className={`${TD} font-medium`}>
                      <Link href={`/pallets/${p.id}`} className="text-blue-800 underline">
                        {p.palletNumber}
                      </Link>
                    </th>
                    <td className={`${TD} whitespace-nowrap text-neutral-700`}>
                      {created(p.createdAt)}
                    </td>
                    <td className={`${TD} hidden text-neutral-700 md:table-cell`}>
                      {p.description ?? '—'}
                    </td>
                    <td className={TD}>
                      <span className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-700">
                        {layoutLabel(p.entryLayout)}
                      </span>
                    </td>
                    <td className={TD}>
                      <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs">
                        {formatLabel(p.status)}
                      </span>
                    </td>
                    <td className={`${TD} hidden tabular-nums sm:table-cell`}>
                      {p.totalQuantity}
                    </td>
                    <td className={`${TD} hidden tabular-nums lg:table-cell`}>{p.lineCount}</td>
                    <td className={`${TD} hidden text-neutral-700 lg:table-cell`}>
                      {p.location?.name ?? '—'}
                    </td>
                  </tr>

                  {/* Phone detail row: the columns hidden above, rather than
                      squeezing nine columns into 320px. */}
                  {isOpen && (
                    <tr className="sm:hidden">
                      <td colSpan={canManage ? 7 : 6} className="bg-neutral-50 px-3 py-2">
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          <dt className="text-neutral-600">Description</dt>
                          <dd>{p.description ?? '—'}</dd>
                          <dt className="text-neutral-600">Supplier</dt>
                          <dd>{p.supplier || '—'}</dd>
                          <dt className="text-neutral-600">Units</dt>
                          <dd className="tabular-nums">{p.totalQuantity}</dd>
                          <dt className="text-neutral-600">Variants</dt>
                          <dd className="tabular-nums">{p.lineCount}</dd>
                          <dt className="text-neutral-600">Location</dt>
                          <dd>{p.location?.name ?? '—'}</dd>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}

            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 10 : 9}
                  className="px-4 py-10 text-center text-sm text-neutral-600"
                >
                  {pallets.length === 0
                    ? 'No pallets yet.'
                    : 'No pallets match these filters.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
