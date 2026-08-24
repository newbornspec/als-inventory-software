'use client';

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Package,
  Search,
  Truck,
  X,
} from 'lucide-react';
import {
  deletePallets,
  setPalletsStatus,
  type BulkPalletResult,
  type Pallet,
} from '@/lib/actions/pallets';
import { formatLabel } from '@/lib/asset-options';
import { MergeDialog } from './merge-dialog';
import { RowActions } from './row-actions';
import {
  applyFilters,
  MAX_EXPORT_PALLETS,
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
const TH =
  'px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500';
const TD = 'px-3 py-2 text-sm';
const PAGE_SIZE = 10;

// Status is state, so it gets colour as well as a word — but never colour
// alone: the pill text is the status name.
const STATUS_PILL: Record<string, string> = {
  open: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  ready: 'border-blue-200 bg-blue-50 text-blue-800',
  shipped: 'border-neutral-300 bg-neutral-100 text-neutral-700',
  merged: 'border-amber-200 bg-amber-50 text-amber-800',
};

export interface PalletPageAbilities {
  create: boolean;
  export: boolean;
  merge: boolean;
  delete: boolean;
  changeStatus: boolean;
}

// Pinned to Europe/London rather than the runtime's own zone. This is a client
// component, so the same line runs on the server during SSR and again in the
// browser — and an unpinned toLocaleDateString gives two different answers when
// those disagree, which React reports as a hydration mismatch and resolves by
// throwing away the server tree. Pinning also stops a pallet booked in at
// 00:20 BST from displaying as the previous day.
function created(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/London',
  });
}

// Sortable column header. aria-sort is what actually tells a screen reader which
// column is ordered and which way — the arrow is decoration.
// Announced order has to describe the column's own data. "Oldest first" on a
// Units column tells a screen reader user nothing about whether the smallest or
// largest count is on top.
const ORDER_WORDS: Record<'date' | 'number' | 'text', [string, string]> = {
  date: ['oldest first', 'newest first'],
  number: ['lowest first', 'highest first'],
  text: ['A to Z', 'Z to A'],
};

function SortHeader({
  label,
  kind,
  active,
  dir,
  onSort,
  className,
}: {
  label: string;
  kind: 'date' | 'number' | 'text';
  active: boolean;
  dir: SortDir;
  onSort: () => void;
  className?: string;
}) {
  const [asc, desc] = ORDER_WORDS[kind];
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`${TH} ${className ?? ''}`}
    >
      <button
        onClick={onSort}
        // uppercase is not inherited: a button carries the UA stylesheet's
        // `text-transform: none`, which left the sortable columns in sentence
        // case beside uppercase ones in the same row.
        className="inline-flex items-center gap-1 uppercase hover:text-neutral-900"
        aria-label={`Sort by ${label}${active ? `, currently ${dir === 'asc' ? asc : desc}` : ''}`}
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

// One KPI card in the strip. The footer link is the card's single action, and
// it only exists where there is an honest destination or effect.
function StatCard({
  icon,
  label,
  value,
  action,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  action?: { label: string; onClick?: () => void; href?: string };
}) {
  return (
    // A cell, not a card: the strip below draws the hairlines, so five of these
    // read as one instrument panel rather than five competing boxes.
    <div className="flex items-start gap-3 bg-white p-4">
      <span className="rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-[#2b7fff]" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
        <div className="mt-1 text-xl font-semibold leading-tight tabular-nums text-neutral-950">
          {value}
        </div>
        {action &&
          (action.href ? (
            <Link href={action.href} className="mt-1 inline-block text-xs text-[#1a6ef5] hover:underline">
              {action.label}
            </Link>
          ) : (
            <button
              onClick={action.onClick}
              className="mt-1 text-xs text-[#1a6ef5] hover:underline"
            >
              {action.label}
            </button>
          ))}
      </div>
    </div>
  );
}

export function PalletWorkspace({
  pallets,
  can,
}: {
  pallets: Pallet[];
  can: PalletPageAbilities;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<PalletFilterState>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>('created');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<{ text: string; failed: boolean } | null>(null);
  // The bulk status choice is only a CHOICE until Apply commits it — firing on
  // the select's own change event opened a confirm dialog per arrow-press for
  // keyboard users (Windows selects emit change while browsing options).
  const [statusChoice, setStatusChoice] = useState('');
  // Removing a chip unmounts the button under focus; send focus somewhere
  // stable and related instead of letting it fall to <body>.
  const filtersBtnRef = useRef<HTMLButtonElement>(null);

  const canSelect = can.export || can.merge || can.delete || can.changeStatus;

  const set = <K extends keyof PalletFilterState>(k: K, v: PalletFilterState[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  // A new question starts on page one; keeping page 3 of the previous answer
  // would show an empty table for no reason the user can see.
  useEffect(() => {
    setPage(1);
  }, [filters, sortKey, sortDir]);

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

  // The KPI strip reads over EVERYTHING, filtered or not — it answers "what do
  // we hold", while the table below answers the current question.
  const kpis = useMemo(() => {
    const units = pallets.reduce((n, p) => n + (p.totalQuantity ?? 0), 0);
    const locs = new Set(pallets.map((p) => p.location?.id).filter(Boolean)).size;
    const sups = new Set(pallets.map((p) => p.supplier).filter(Boolean)).size;
    const open = pallets.filter((p) => p.status === 'open').length;
    const ready = pallets.filter((p) => p.status === 'ready').length;
    return { units, locs, sups, open, ready };
  }, [pallets]);

  const visible = useMemo(
    () => sortPallets(applyFilters(pallets, filters), sortKey, sortDir),
    [pallets, filters, sortKey, sortDir],
  );

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const paged = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const activeFilters = countActiveFilters(filters);
  const selectedList = visible.filter((p) => selected.has(p.id));
  const allPageSelected = paged.length > 0 && paged.every((p) => selected.has(p.id));
  const somePageSelected = paged.some((p) => selected.has(p.id));
  // Select-all over a big selection is one click, and the server refuses past
  // the cap. Saying so here beats navigating the operator to an error page.
  const tooManyToExport = selectedList.length > MAX_EXPORT_PALLETS;

  // "Merge with…" from a row menu selects that pallet and leaves the operator
  // one click from the pair the merge needs, rather than opening a dialog that
  // immediately complains it has only one pallet.
  function startMerge(id: string) {
    setSelected((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
  }

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

  function togglePage() {
    setSelected((s) => {
      const next = new Set(s);
      if (allPageSelected) paged.forEach((p) => next.delete(p.id));
      else paged.forEach((p) => next.add(p.id));
      return next;
    });
  }

  function report(verb: string, res: BulkPalletResult) {
    const parts: string[] = [];
    if (res.done > 0) parts.push(`${verb} ${res.done} pallet${res.done === 1 ? '' : 's'}.`);
    for (const f of res.failed) parts.push(`${f.palletNumber}: ${f.error}`);
    setBulkMsg({ text: parts.join(' '), failed: res.failed.length > 0 });
  }

  async function bulkStatus(status: string) {
    const label = formatLabel(status);
    if (!window.confirm(`Change ${selectedList.length} pallet${selectedList.length === 1 ? '' : 's'} to ${label}?`)) {
      return;
    }
    setBusy(true);
    setBulkMsg(null);
    // finally, so a thrown server action (network drop, revoked permission)
    // can't leave the footer locked on busy forever.
    try {
      const res = await setPalletsStatus(
        selectedList.map((p) => ({ id: p.id, palletNumber: p.palletNumber })),
        status,
      );
      report(`Changed status on`, res);
      setSelected(new Set());
      setStatusChoice('');
      router.refresh();
    } catch {
      setBulkMsg({
        text: 'Something went wrong mid-change — reload the page and check which pallets were updated.',
        failed: true,
      });
    } finally {
      setBusy(false);
    }
  }

  async function bulkDelete() {
    const n = selectedList.length;
    // Truthful about what the server actually does: a quantity pallet deletes
    // TOGETHER WITH its lines (the cascade is deliberate); only pallets still
    // holding serialized devices refuse, and merged pallets stay as history.
    if (
      !window.confirm(
        `Delete ${n} pallet${n === 1 ? '' : 's'}? A quantity pallet is deleted together with the stock lines on it. ` +
          `Pallets still holding serialized devices will refuse (move the devices off first), and merged pallets are kept as history.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setBulkMsg(null);
    try {
      const res = await deletePallets(
        selectedList.map((p) => ({ id: p.id, palletNumber: p.palletNumber })),
      );
      report('Deleted', res);
      setSelected(new Set());
      router.refresh();
    } catch {
      setBulkMsg({
        text: 'Something went wrong mid-delete — reload the page and check which pallets remain.',
        failed: true,
      });
    } finally {
      setBusy(false);
    }
  }

  // The active filters, spelled out as removable chips — each one names its
  // field and value, and its × removes exactly that filter.
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (filters.search.trim()) {
    chips.push({
      key: 'search',
      label: `Search: “${filters.search.trim()}”`,
      clear: () => set('search', ''),
    });
  }
  if (filters.preset !== 'any') {
    const label =
      filters.preset === 'custom'
        ? `Created: ${filters.from || '…'} – ${filters.to || '…'}`
        : `Created: ${DATE_PRESETS.find((p) => p.value === filters.preset)?.label ?? ''}`;
    chips.push({
      key: 'created',
      label,
      clear: () => setFilters((f) => ({ ...f, preset: 'any' as DatePreset, from: '', to: '' })),
    });
  }
  if (filters.layout) {
    chips.push({
      key: 'layout',
      label: `Layout: ${layoutLabel(filters.layout)}`,
      clear: () => set('layout', ''),
    });
  }
  if (filters.statuses.length > 0) {
    chips.push({
      key: 'status',
      label: `Status: ${filters.statuses.map(formatLabel).join(', ')}`,
      clear: () => set('statuses', []),
    });
  }
  if (filters.location) {
    const name = locations.find(([id]) => id === filters.location)?.[1] ?? 'Unknown';
    chips.push({
      key: 'location',
      label: `Location: ${name}`,
      clear: () => set('location', ''),
    });
  }
  if (filters.supplier) {
    chips.push({
      key: 'supplier',
      label: `Supplier: ${filters.supplier}`,
      clear: () => set('supplier', ''),
    });
  }

  // Compact pager: first, last, and a window around the current page. With few
  // pages, just all of them.
  const pageNumbers = useMemo(() => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
    const around = [safePage - 1, safePage, safePage + 1].filter((n) => n > 1 && n < pageCount);
    const out: (number | '…')[] = [1];
    if (around[0] !== undefined && around[0] > 2) out.push('…');
    out.push(...around);
    if (around.length > 0 && around[around.length - 1] < pageCount - 1) out.push('…');
    out.push(pageCount);
    return out;
  }, [pageCount, safePage]);

  const showFrom = visible.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const showTo = Math.min(safePage * PAGE_SIZE, visible.length);
  const columnCount = (canSelect ? 1 : 0) + 11;

  return (
    <div className="mt-6">
      {/* --- KPI strip ----------------------------------------------------- */}
      <div className="grid gap-px overflow-hidden rounded-xl border border-neutral-200 bg-neutral-200 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          icon={<Package className="size-5" />}
          label="Total pallets"
          value={pallets.length.toLocaleString('en-GB')}
          action={{ label: 'View all', onClick: () => setFilters(EMPTY_FILTERS) }}
        />
        <StatCard
          icon={<Boxes className="size-5" />}
          label="Total units"
          value={kpis.units.toLocaleString('en-GB')}
          action={{ label: 'View units', href: '/inventory' }}
        />
        <StatCard
          icon={<MapPin className="size-5" />}
          label="Locations"
          value={kpis.locs}
          action={{ label: 'View locations', onClick: () => setShowFilters(true) }}
        />
        <StatCard
          icon={<BadgeCheck className="size-5" />}
          label="Status"
          value={
            <span className="flex flex-wrap items-baseline gap-x-3">
              <span>
                {kpis.open} <span className="text-sm font-normal text-neutral-600">Open</span>
              </span>
              <span>
                {kpis.ready} <span className="text-sm font-normal text-neutral-600">Ready</span>
              </span>
            </span>
          }
          action={{ label: 'View by status', onClick: () => setShowFilters(true) }}
        />
        <StatCard
          icon={<Truck className="size-5" />}
          label="Suppliers"
          value={kpis.sups}
          action={{ label: 'View suppliers', onClick: () => setShowFilters(true) }}
        />
      </div>

      {/* --- search + filters ---------------------------------------------- */}
      <div className="mt-4 rounded-xl border border-neutral-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <label htmlFor="pallet-search" className="sr-only">
              Search pallets by number, description, supplier or location
            </label>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-neutral-500"
              aria-hidden="true"
            />
            <input
              id="pallet-search"
              type="search"
              value={filters.search}
              onChange={(e) => set('search', e.target.value)}
              placeholder="Search pallets by number, description, supplier or location…"
              className={`${FIELD} w-full bg-white pl-8`}
            />
          </div>

          <button
            ref={filtersBtnRef}
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            aria-controls="pallet-filters"
            className="rounded-md border border-[var(--control-border)] bg-white px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
          >
            Filters{activeFilters > 0 ? ` (${activeFilters})` : ''}
          </button>

          {chips.map((c) => (
            <span
              key={c.key}
              className="inline-flex items-center gap-1.5 rounded-full border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-800"
            >
              {c.label}
              <button
                onClick={() => {
                  c.clear();
                  filtersBtnRef.current?.focus();
                }}
                aria-label={`Remove filter — ${c.label}`}
                className="rounded-full text-neutral-500 hover:text-neutral-900"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}

          {activeFilters > 0 && (
            <button
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="text-sm text-[#1a6ef5] hover:underline"
            >
              Clear all
            </button>
          )}
        </div>

        <div
          id="pallet-filters"
          hidden={!showFilters}
          className="mt-3 grid gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4 sm:grid-cols-2 lg:grid-cols-3"
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
              <option value="asset">Serialized</option>
            </select>
          </div>

          <fieldset>
            <legend className="text-sm text-neutral-700">Status</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
              {statuses.map((s) => (
                <label key={s} className="inline-flex items-center gap-1.5 text-sm text-neutral-800">
                  <input
                    type="checkbox"
                    checked={filters.statuses.includes(s)}
                    onChange={(e) =>
                      set(
                        'statuses',
                        e.target.checked
                          ? [...filters.statuses, s]
                          : filters.statuses.filter((x) => x !== s),
                      )
                    }
                    className="size-4 accent-[#1a6ef5]"
                  />
                  {formatLabel(s)}
                </label>
              ))}
            </div>
          </fieldset>

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
      </div>

      {/* --- announcements -------------------------------------------------- */}
      <div aria-live="polite" className="sr-only">
        {selectedList.length > 0 ? `${selectedList.length} pallets selected` : ''}
      </div>
      {bulkMsg && (
        <p
          role="status"
          className={`mt-3 text-sm ${bulkMsg.failed ? 'text-red-700' : 'text-emerald-700'}`}
        >
          {bulkMsg.text}
        </p>
      )}
      {tooManyToExport && (
        <p className="mt-3 text-sm text-red-700">
          Too many to export at once — narrow the selection to {MAX_EXPORT_PALLETS} or fewer.
        </p>
      )}

      {/* --- table ----------------------------------------------------------- */}
      <div className="mt-4 overflow-hidden rounded-xl border border-neutral-200 bg-white">
        {/* `relative` is load-bearing: the table is wider than a phone and
            carries sr-only text, which Tailwind implements as
            position:absolute. With no positioned ancestor it resolves against
            the initial containing block, landing past the viewport where
            nothing can clip it — and the whole page scrolls sideways. */}
        <div
          role="region"
          aria-label="Pallets"
          tabIndex={0}
          className="relative overflow-x-auto"
        >
          {/* The min-width applies only where every column is on show. Forcing
              832px at phone width made the reader pan horizontally on every row —
              which is precisely what the disclosure row exists to avoid. */}
          <table className="w-full border-collapse text-left text-sm lg:min-w-[64rem]">
            <caption className="sr-only">
              Pallets with creation date, layout, status, unit counts and location.
              {activeFilters > 0 ? ` Filtered: ${visible.length} of ${pallets.length}.` : ''}
              {` Page ${safePage} of ${pageCount}.`}
            </caption>
            <thead className="bg-neutral-50">
              <tr>
                {canSelect && (
                  <th scope="col" className={`${TH} w-10`}>
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      ref={(el) => {
                        // Indeterminate is the honest state for a partial
                        // selection — neither checked nor empty.
                        if (el) el.indeterminate = somePageSelected && !allPageSelected;
                      }}
                      onChange={togglePage}
                      aria-label={
                        allPageSelected
                          ? `Deselect the ${paged.length} pallets on this page`
                          : `Select the ${paged.length} pallets on this page`
                      }
                      className="size-4 accent-[#1a6ef5]"
                    />
                  </th>
                )}
                {/* lg, not sm: Variants, Supplier and Location stay hidden until
                    lg, so between 640px and 1023px the chevron is the ONLY way to
                    reach them. Hiding it at sm left those columns unreadable on
                    every tablet and half-width laptop window. */}
                <th scope="col" className={`${TH} w-8 lg:hidden`}>
                  <span className="sr-only">Show details</span>
                </th>
                <SortHeader
                  label="Pallet #"
                  kind="text"
                  active={sortKey === 'palletNumber'}
                  dir={sortDir}
                  onSort={() => toggleSort('palletNumber')}
                />
                <SortHeader
                  label="Created"
                  kind="date"
                  active={sortKey === 'created'}
                  dir={sortDir}
                  onSort={() => toggleSort('created')}
                />
                <th scope="col" className={`${TH} hidden md:table-cell`}>Description</th>
                <th scope="col" className={TH}>Layout</th>
                <th scope="col" className={TH}>Status</th>
                <SortHeader
                  label="Units"
                  kind="number"
                  active={sortKey === 'units'}
                  dir={sortDir}
                  onSort={() => toggleSort('units')}
                  className="hidden sm:table-cell"
                />
                <th scope="col" className={`${TH} hidden lg:table-cell`}>Variants</th>
                {/* Supplier stays a real column: you can filter BY a supplier, so
                    you must be able to SEE which supplier a pallet came from. */}
                <th scope="col" className={`${TH} hidden lg:table-cell`}>Supplier</th>
                <th scope="col" className={`${TH} hidden lg:table-cell`}>Location</th>
                <th scope="col" className={`${TH} w-10`}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.map((p) => {
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
                      {canSelect && (
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
                      <td className={`${TD} lg:hidden`}>
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
                        <Link
                          href={`/pallets/${p.id}`}
                          className="text-[#1a6ef5] hover:underline"
                        >
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
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                            STATUS_PILL[p.status] ?? 'border-neutral-300 text-neutral-700'
                          }`}
                        >
                          {formatLabel(p.status)}
                        </span>
                      </td>
                      <td className={`${TD} hidden tabular-nums sm:table-cell`}>
                        {p.totalQuantity}
                      </td>
                      <td className={`${TD} hidden tabular-nums lg:table-cell`}>{p.lineCount}</td>
                      <td className={`${TD} hidden text-neutral-700 lg:table-cell`}>
                        {p.supplier || '—'}
                      </td>
                      <td className={`${TD} hidden text-neutral-700 lg:table-cell`}>
                        {p.location?.name ?? '—'}
                      </td>
                      <td className={TD}>
                        <RowActions
                          pallet={p}
                          canExport={can.export}
                          canMerge={can.merge}
                          onMerge={startMerge}
                        />
                      </td>
                    </tr>

                    {/* The columns hidden at this width, rather than squeezing
                        ten of them into 320px. Spans the full column count —
                        browsers clamp an over-wide colspan to the table, and the
                        visible count changes at every breakpoint. */}
                    {isOpen && (
                      <tr className="lg:hidden">
                        <td colSpan={columnCount} className="bg-neutral-50 px-3 py-2">
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

              {paged.length === 0 && (
                <tr>
                  <td
                    colSpan={columnCount}
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

        {/* --- footer: bulk actions + pagination ----------------------------- */}
        <div className="flex flex-wrap items-center gap-3 border-t border-neutral-200 px-3 py-2.5">
          {canSelect && (
            <>
              <span className="text-sm text-neutral-700 tabular-nums">
                {selectedList.length} selected
                {selectedList.length > 0 &&
                  selectedList.length === visible.length &&
                  activeFilters > 0 &&
                  ' — all matching the current filters'}
              </span>

              {/* The page checkbox only reaches the rows on show; this is the
                  one-click whole-list selection the export flow needs (the
                  server cap is 500 — the button says the real number). */}
              {selectedList.length < visible.length && visible.length > paged.length && (
                <button
                  onClick={() =>
                    setSelected((s) => new Set([...s, ...visible.map((p) => p.id)]))
                  }
                  disabled={busy}
                  className="text-sm text-[#1a6ef5] hover:underline disabled:opacity-50"
                >
                  Select all {visible.length}
                  {activeFilters > 0 ? ' matching' : ''}
                </button>
              )}

              {selectedList.length > 0 && (
                <button
                  onClick={() => setSelected(new Set())}
                  disabled={busy}
                  className="text-sm text-neutral-600 hover:underline disabled:opacity-50"
                >
                  Clear selection
                </button>
              )}

              {can.export && (
                // A real form POST, not a link: the selection can be every pallet
                // in the list, and that many ids belongs in a body rather than in
                // a URL. The response is an attachment, so the browser downloads
                // it and leaves the page — and the selection — where it is.
                <form action="/api/pallets/export" method="POST">
                  <input
                    type="hidden"
                    name="ids"
                    value={selectedList.map((p) => p.id).join(',')}
                  />
                  <button
                    type="submit"
                    disabled={selectedList.length === 0 || tooManyToExport || busy}
                    className="rounded-md border border-[var(--control-border)] px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Export
                  </button>
                </form>
              )}

              {can.changeStatus && (
                <span className="inline-flex items-center gap-1.5">
                  <label htmlFor="bulk-status" className="sr-only">
                    Change status of selected pallets
                  </label>
                  <select
                    id="bulk-status"
                    value={statusChoice}
                    disabled={selectedList.length === 0 || busy}
                    onChange={(e) => setStatusChoice(e.target.value)}
                    className="rounded-md border border-[var(--control-border)] bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 disabled:opacity-50"
                  >
                    {/* Merged is terminal and reachable only through a merge —
                        never offered here; the server rejects it anyway. */}
                    <option value="">Change status</option>
                    <option value="open">Open</option>
                    <option value="ready">Ready</option>
                    <option value="shipped">Shipped</option>
                  </select>
                  {statusChoice && (
                    <button
                      onClick={() => void bulkStatus(statusChoice)}
                      disabled={selectedList.length === 0 || busy}
                      className="rounded-md bg-[#1a6ef5] px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                    >
                      Apply
                    </button>
                  )}
                </span>
              )}

              {can.merge && selectedList.length === 2 && (
                <MergeDialog selected={selectedList} onDone={() => setSelected(new Set())} />
              )}

              {can.delete && (
                <button
                  onClick={() => void bulkDelete()}
                  disabled={selectedList.length === 0 || busy}
                  className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  {busy ? 'Working…' : 'Delete'}
                </button>
              )}
            </>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-3">
            <span className="text-sm text-neutral-600 tabular-nums">
              {visible.length === 0
                ? 'No pallets to show'
                : `Showing ${showFrom} to ${showTo} of ${visible.length} pallet${visible.length === 1 ? '' : 's'}`}
            </span>
            {pageCount > 1 && (
              <nav aria-label="Pallet list pages" className="flex items-center gap-1">
                <button
                  onClick={() => setPage(Math.max(1, safePage - 1))}
                  disabled={safePage === 1}
                  aria-label="Previous page"
                  className="rounded-md border border-[var(--control-border)] p-1.5 text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </button>
                {pageNumbers.map((n, i) =>
                  n === '…' ? (
                    <span key={`gap-${i}`} className="px-1 text-sm text-neutral-500">
                      …
                    </span>
                  ) : (
                    <button
                      key={n}
                      onClick={() => setPage(n)}
                      aria-current={n === safePage ? 'page' : undefined}
                      className={
                        'min-w-8 rounded-md border px-2 py-1 text-sm tabular-nums ' +
                        (n === safePage
                          ? 'border-[#1a6ef5] text-[#1a6ef5]'
                          : 'border-transparent text-neutral-700 hover:bg-neutral-50')
                      }
                    >
                      {n}
                    </button>
                  ),
                )}
                <button
                  onClick={() => setPage(Math.min(pageCount, safePage + 1))}
                  disabled={safePage === pageCount}
                  aria-label="Next page"
                  className="rounded-md border border-[var(--control-border)] p-1.5 text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </nav>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
