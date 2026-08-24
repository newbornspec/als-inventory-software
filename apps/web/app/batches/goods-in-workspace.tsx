'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Check, ChevronDown, ChevronRight, RotateCw } from 'lucide-react';
import type { Batch } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import { setAuditLot } from '@/lib/actions/devices';
import { formatLabel } from '@/lib/asset-options';
import { ComponentSpecsTable } from '@/app/components/component-specs';
import { specRows, type HardwareProfileLike } from '@/lib/hardware-spec';
import { DeleteBatchButton } from './delete-batch-button';
import { MoveToPallet } from './move-to-pallet';
import { TransferBatch } from './transfer-batch';

// The Goods In workspace, laid out as the client's mockup: three stacked
// panels that drill down — Lots Registry (pick a lot) → Lot Inventory Units
// (pick a unit) → Component Specs (the unit's captured hardware). Everything
// the old accordion could do still happens here: the per-lot actions moved
// into the units panel's toolbar, where they act on the selected lot.

// A lot can hold hundreds of devices. Rendering all of them pushed the
// Component Specs panel — the payoff of the whole drill-down — below an
// unbounded wall of rows, so the third panel was effectively unreachable on a
// real lot. The list pages.
const UNITS_PER_PAGE = 25;

const TH =
  'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500';
const TD = 'px-4 py-2.5 text-sm';

// Lot status → pill tone. Text always accompanies the colour.
const LOT_PILL: Record<string, string> = {
  draft: 'border-amber-200 bg-amber-50 text-amber-800',
  awaiting_arrival: 'border-amber-200 bg-amber-50 text-amber-800',
  open: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  receiving: 'border-blue-200 bg-blue-50 text-blue-800',
  closed: 'border-neutral-300 bg-neutral-100 text-neutral-700',
  reconciled: 'border-neutral-300 bg-neutral-100 text-neutral-700',
  sold: 'border-neutral-300 bg-neutral-100 text-neutral-700',
};

// Audit verdict → pill tone, mirroring the /audit workspace's chipClass so the
// same value never reads green here and red there. A failed wipe must never
// hide behind a generic green "Audited" — this is an ITAD compliance surface.
const BAD_VERDICTS = [
  'failed_testing',
  'no_power',
  'post_failed',
  'bios_locked',
  'missing_components',
  'data_wipe_failed',
  'repair_required',
  'ber',
];
const GOOD_VERDICTS = ['passed_testing', 'ready_for_sale', 'refurbished', 'data_wiped'];
function verdictClass(value: string): string {
  if (BAD_VERDICTS.includes(value)) return 'border-red-200 bg-red-50 text-red-800';
  if (GOOD_VERDICTS.includes(value)) return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  return 'border-neutral-300 bg-neutral-100 text-neutral-700';
}

const GRADE_LETTER: Record<string, string> = {
  grade_a: 'A',
  grade_b: 'B',
  grade_c: 'C',
  grade_d: 'D',
  for_parts: 'FP',
  scrap: 'SC',
};

// Collapsible panel chrome shared by all three sections.
function Panel({
  id,
  title,
  subtitle,
  right,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <button
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={id}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-neutral-500" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-neutral-500" aria-hidden="true" />
          )}
          <span className="text-xs font-semibold uppercase tracking-wide text-neutral-900">
            {title}
          </span>
          {/* neutral-500, not 400 — this line is load-bearing (it names the
              selected lot/unit the panel's actions will hit), so it must meet
              small-text contrast. */}
          {subtitle && <span className="text-xs text-neutral-600">{subtitle}</span>}
        </button>
        {right && <div className="ml-auto flex flex-wrap items-center gap-3">{right}</div>}
      </div>
      <div id={id} hidden={!open} className="border-t border-neutral-200">
        {children}
      </div>
    </section>
  );
}

type LotUnits = { loading: boolean; error: string | null; assets: Asset[] };
type UnitDetail = { loading: boolean; error: string | null; asset: Asset | null };

export function GoodsInWorkspace({
  lots,
  canExport,
  canDelete,
  canMove,
  activeAuditLotId,
  viewer,
}: {
  lots: Batch[];
  canExport: boolean;
  canDelete: boolean;
  canMove?: boolean;
  activeAuditLotId: string | null;
  viewer: string;
}) {
  const router = useRouter();
  const [openLots, setOpenLots] = useState(true);
  const [openUnits, setOpenUnits] = useState(true);
  const [openSpecs, setOpenSpecs] = useState(true);

  // Status filter — options come from the data, all on by default.
  const statuses = useMemo(() => [...new Set(lots.map((l) => l.status))].sort(), [lots]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visibleLots = useMemo(
    () => lots.filter((l) => !hidden.has(l.status)),
    [lots, hidden],
  );

  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  // Keep the selection valid as filters change; default to the first lot so
  // the drill-down shows something immediately.
  useEffect(() => {
    if (!visibleLots.some((l) => l.id === selectedLotId)) {
      setSelectedLotId(visibleLots[0]?.id ?? null);
    }
  }, [visibleLots, selectedLotId]);
  const lot = visibleLots.find((l) => l.id === selectedLotId) ?? null;

  // Units of the selected lot — the full register view (palletised devices
  // included, with their pallet linked), same as the lot detail page.
  const [units, setUnits] = useState<LotUnits>({ loading: false, error: null, assets: [] });
  const [unitFilter, setUnitFilter] = useState<'all' | 'audited' | 'pending'>('all');
  const [unitPage, setUnitPage] = useState(1);
  const [picked, setPicked] = useState<string[]>([]); // pool rows ticked for Move to Pallet
  // Outcome of the last Move to Pallet, kept by the component that survives it.
  const [moveOutcome, setMoveOutcome] = useState<string | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UnitDetail>({ loading: false, error: null, asset: null });

  // Staleness guards: responses land out of order when a big lot answers
  // slower than a small one clicked after it, and a late response must NEVER
  // render under the wrong heading — ticking those rows would move the wrong
  // lot's devices. Each request stamps the ref; only the response whose stamp
  // still matches may write state.
  const lotReq = useRef<string | null>(null);
  const unitReq = useRef<string | null>(null);

  // --- Refresh -----------------------------------------------------------
  // The audit station writes into the selected lot from another machine, so
  // this panel goes stale the moment a unit is captured. Refresh re-fetches
  // the devices AND re-runs the server component (the lot-level chips above
  // the table are server data), then reports what actually arrived — a silent
  // repaint of a table that looks identical can't be told apart from a button
  // that does nothing, and a re-audit changes a verdict without changing the
  // row count.
  const [refreshing, setRefreshing] = useState(false);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<string | null>(null);
  const prevSig = useRef<Map<string, string> | null>(null);

  function signatureOf(assets: Asset[]): Map<string, string> {
    return new Map(
      assets.map((a) => [
        a.id,
        [a.auditStatus ?? '', a.conditionGrade ?? '', a.stockStatus, a.palletId ?? ''].join('|'),
      ]),
    );
  }

  async function loadUnits(lotId: string, mode: 'initial' | 'refresh' = 'initial') {
    lotReq.current = lotId;
    // A refresh keeps the current rows on screen — blanking the table to a
    // spinner for a re-fetch loses the operator's place for no reason. Only a
    // first load has nothing to show.
    if (mode === 'initial') setUnits({ loading: true, error: null, assets: [] });
    else setRefreshing(true);
    try {
      const res = await fetch(`/api/assets?batchId=${lotId}`);
      if (!res.ok) throw new Error('failed');
      const assets: Asset[] = await res.json();
      if (lotReq.current !== lotId) return; // a newer selection superseded this
      setUnits({ loading: false, error: null, assets });
      setLastLoaded(
        new Date().toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );

      const prev = prevSig.current;
      const next = signatureOf(assets);
      prevSig.current = next;
      if (mode === 'refresh' && prev) {
        let added = 0;
        let updated = 0;
        for (const [id, sig] of next) {
          const before = prev.get(id);
          if (before === undefined) added += 1;
          else if (before !== sig) updated += 1;
        }
        let removed = 0;
        for (const id of prev.keys()) if (!next.has(id)) removed += 1;
        const parts: string[] = [];
        if (added > 0) parts.push(`${added} new device${added === 1 ? '' : 's'}`);
        if (updated > 0) parts.push(`${updated} updated`);
        if (removed > 0) parts.push(`${removed} no longer in this lot`);
        setChangeNote(parts.length > 0 ? parts.join(' · ') : 'No changes yet.');
      }
      // A device can leave the pool between loads (someone else palletised
      // it); keep only picks that are still movable rather than sending a
      // stale id into Move to Pallet.
      setPicked((cur) => {
        const pool = new Set(assets.filter((a) => !a.palletId).map((a) => a.id));
        return cur.filter((id) => pool.has(id));
      });
    } catch {
      if (lotReq.current !== lotId) return;
      if (mode === 'refresh') {
        // The rows on screen are still the last good ones — say the refresh
        // failed instead of wiping a table that is merely stale.
        setChangeNote('Could not refresh — the devices shown may be out of date.');
      } else {
        setUnits({ loading: false, error: 'Could not load this lot’s devices.', assets: [] });
      }
    } finally {
      if (mode === 'refresh') setRefreshing(false);
    }
  }

  function onRefresh() {
    if (!selectedLotId) return;
    setChangeNote(null);
    void loadUnits(selectedLotId, 'refresh');
    // The Stat chips (Total/Audited/Pending/Unallocated) and the Lots Registry
    // are server-rendered, so they need the route re-run to move too.
    router.refresh();
  }

  useEffect(() => {
    setPicked([]);
    setSelectedUnitId(null);
    setDetail({ loading: false, error: null, asset: null });
    setUnitFilter('all');
    // A different lot means the previous lot's comparison and its "1 new
    // device" note are meaningless — start clean rather than reporting one
    // lot's changes against another's.
    setChangeNote(null);
    prevSig.current = null;
    if (selectedLotId) void loadUnits(selectedLotId);
    else setUnits({ loading: false, error: null, assets: [] });
  }, [selectedLotId]);

  // Changing the Audited/Pending filter drops the picks: rows hidden by a
  // filter must never ride silently into a Move to Pallet, and the header
  // select-all must never silently REPLACE picks the user can't see.
  useEffect(() => {
    setPicked([]);
  }, [unitFilter]);

  async function pickUnit(id: string) {
    unitReq.current = id;
    setSelectedUnitId(id);
    setDetail({ loading: true, error: null, asset: null });
    try {
      const res = await fetch(`/api/assets/${id}`);
      if (!res.ok) throw new Error('failed');
      const asset = await res.json();
      if (unitReq.current !== id) return; // a newer click superseded this
      setDetail({ loading: false, error: null, asset });
    } catch {
      if (unitReq.current !== id) return;
      setDetail({ loading: false, error: 'Could not load this unit’s hardware.', asset: null });
    }
  }

  const audited = units.assets.filter((a) => a.auditStatus != null);
  const pendingUnits = units.assets.filter((a) => a.auditStatus == null);
  const shownUnits =
    unitFilter === 'audited' ? audited : unitFilter === 'pending' ? pendingUnits : units.assets;
  const pageCount = Math.max(1, Math.ceil(shownUnits.length / UNITS_PER_PAGE));
  const pageStart = (unitPage - 1) * UNITS_PER_PAGE;
  const pageUnits = shownUnits.slice(pageStart, pageStart + UNITS_PER_PAGE);
  // Selection is scoped to the page the checkbox sits above — a tick that
  // silently claimed 400 devices from a header over 25 rows would be a nasty
  // surprise on a real mutation. Selections still ACCUMULATE across pages, and
  // the move bar states the running total.
  const poolShown = pageUnits.filter((a) => !a.palletId);
  const allPoolPicked = poolShown.length > 0 && poolShown.every((a) => picked.includes(a.id));

  // Landing on page 7 of a 2-page list shows an empty table, so any change to
  // what is being listed returns to the first page.
  useEffect(() => {
    setUnitPage(1);
  }, [selectedLotId, unitFilter]);
  useEffect(() => {
    if (unitPage > pageCount) setUnitPage(pageCount);
  }, [unitPage, pageCount]);

  const rows = specRows((detail.asset?.hardwareProfile as HardwareProfileLike | null) ?? null);
  const selectedUnit = units.assets.find((a) => a.id === selectedUnitId) ?? null;

  // Reconciliation numbers for the selected lot — same arithmetic the old
  // accordion used (Total counts palletised devices; Unallocated is the pool).
  const expected = lot?.expectedUnitCount ?? null;
  const scanned = lot?.actualUnitCount ?? 0;
  const missing = expected != null ? Math.max(0, expected - scanned) : null;
  const extra = expected != null ? Math.max(0, scanned - expected) : null;
  const pendingCount = lot ? Math.max(0, scanned - lot.audited) : 0;
  const unallocated = lot ? (lot.unallocatedCount ?? scanned) : 0;
  const isTarget = lot != null && lot.id === activeAuditLotId;

  return (
    <div className="mt-8 flex flex-col gap-4">
      {/* ============ 1 · LOTS REGISTRY ============ */}
      <Panel
        id="panel-lots"
        title="Lots Registry"
        subtitle={
          hidden.size > 0
            ? `${visibleLots.length} of ${lots.length} lots`
            : `${lots.length} lot${lots.length === 1 ? '' : 's'}`
        }
        open={openLots}
        onToggle={() => setOpenLots((v) => !v)}
        right={
          <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <legend className="sr-only">Filter lots by status</legend>
            <span className="text-xs text-neutral-500" aria-hidden="true">
              Filter status:
            </span>
            {statuses.map((s) => (
              <label key={s} className="inline-flex items-center gap-1.5 text-xs text-neutral-700">
                <input
                  type="checkbox"
                  checked={!hidden.has(s)}
                  onChange={(e) =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (e.target.checked) next.delete(s);
                      else next.add(s);
                      return next;
                    })
                  }
                  className="size-3.5 accent-[#1a6ef5]"
                />
                {formatLabel(s)}
              </label>
            ))}
          </fieldset>
        }
      >
        <div role="region" aria-label="Lots" tabIndex={0} className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">
              Incoming lots. Selecting a row loads its devices in the panel below.
            </caption>
            <thead className="bg-neutral-50">
              <tr>
                <th scope="col" className={TH}>Lot ID</th>
                <th scope="col" className={`${TH} hidden md:table-cell`}>Owner</th>
                <th scope="col" className={`${TH} hidden md:table-cell`}>Supplier</th>
                <th scope="col" className={`${TH} hidden lg:table-cell`}>Description</th>
                <th scope="col" className={TH}>Status</th>
                <th scope="col" className={`${TH} hidden sm:table-cell`}>Created</th>
                <th scope="col" className={`${TH} text-right`}>Total units</th>
                <th scope="col" className={`${TH} hidden text-right sm:table-cell`}>Unallocated</th>
                <th scope="col" className={`${TH} w-10`}>
                  <span className="sr-only">Open lot</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleLots.map((l) => {
                const isSel = l.id === selectedLotId;
                return (
                  <tr
                    key={l.id}
                    className={
                      'border-t border-neutral-200 ' +
                      (isSel ? 'border-l-4 border-l-[#1a6ef5] bg-blue-50/60' : 'hover:bg-neutral-50')
                    }
                  >
                    <th scope="row" className={`${TD} font-medium`}>
                      {/* The lot number SELECTS (drill-down); the arrow at the
                          row's end navigates to the full lot page. aria-current
                          on the button is what a screen reader actually
                          announces — aria-selected on a static table row is
                          ignored outside grid widgets. */}
                      <button
                        onClick={() => setSelectedLotId(l.id)}
                        aria-label={`Show devices in ${l.batchNumber}`}
                        aria-current={isSel ? 'true' : undefined}
                        className="text-[#1a6ef5] hover:underline"
                      >
                        {l.batchNumber}
                      </button>
                      {l.id === activeAuditLotId && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                          <Check className="size-2.5" aria-hidden="true" />
                          Audit target
                        </span>
                      )}
                    </th>
                    <td className={`${TD} hidden text-neutral-600 md:table-cell`}>
                      {l.owner?.name ?? '—'}
                    </td>
                    <td className={`${TD} hidden text-neutral-600 md:table-cell`}>
                      {l.source ?? '—'}
                    </td>
                    <td className={`${TD} hidden max-w-64 truncate text-neutral-600 lg:table-cell`}>
                      {l.notes ?? '—'}
                    </td>
                    <td className={TD}>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                          LOT_PILL[l.status] ?? 'border-neutral-300 text-neutral-700'
                        }`}
                      >
                        {formatLabel(l.status)}
                      </span>
                    </td>
                    <td className={`${TD} hidden whitespace-nowrap text-neutral-600 sm:table-cell`}>
                      {l.createdAt
                        ? new Date(l.createdAt).toLocaleDateString('en-GB', {
                            timeZone: 'Europe/London',
                          })
                        : '—'}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>
                      {l.actualUnitCount}
                      {l.expectedUnitCount != null && (
                        <span className="text-neutral-400"> / {l.expectedUnitCount}</span>
                      )}
                    </td>
                    <td className={`${TD} hidden text-right tabular-nums text-neutral-600 sm:table-cell`}>
                      {l.unallocatedCount ?? l.actualUnitCount}
                    </td>
                    <td className={TD}>
                      <Link
                        href={`/batches/${l.id}`}
                        aria-label={`Open ${l.batchNumber}`}
                        className="text-neutral-500 hover:text-neutral-900"
                      >
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {visibleLots.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-sm text-neutral-500">
                    {lots.length === 0 ? 'No lots yet.' : 'Every status is filtered out.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ============ 2 · LOT INVENTORY UNITS ============ */}
      <Panel
        id="panel-units"
        title="Lot Inventory Units"
        subtitle={lot ? `Lot: ${lot.batchNumber}` : 'No lot selected'}
        open={openUnits}
        onToggle={() => setOpenUnits((v) => !v)}
        right={
          lot && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {!units.error && (
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  role="group"
                  aria-label="Filter units by audit state"
                >
                  {/* While the fetch is in flight the derived counts would read a
                      confident (0) — an ellipsis is the honest value. On error the
                      chips hide entirely rather than filter a table that isn't there. */}
                  {(
                    [
                      ['audited', `Audited (${units.loading ? '…' : audited.length})`],
                      ['pending', `Pending (${units.loading ? '…' : pendingUnits.length})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setUnitFilter((f) => (f === key ? 'all' : key))}
                      aria-pressed={unitFilter === key}
                      className={
                        'rounded-md border px-3 py-1 text-xs font-medium ' +
                        (unitFilter === key
                          ? 'border-blue-200 bg-blue-50 text-[#1a6ef5]'
                          : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50')
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing || units.loading}
                aria-label={`Refresh the devices in ${lot.batchNumber}`}
                className="inline-flex shrink-0 items-center gap-2 rounded-md border border-[var(--control-border)] px-3 py-1 text-xs font-medium text-neutral-800 transition-colors hover:bg-neutral-50 disabled:opacity-60"
              >
                <RotateCw
                  className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'}
                  aria-hidden="true"
                />
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
              {lastLoaded && (
                <span className="text-xs text-neutral-500">Updated {lastLoaded}</span>
              )}
              {/* Only the outcome is live — the timestamp changes on every load
                  and would otherwise be announced each time for no reason. */}
              <span
                aria-live="polite"
                className={
                  'text-xs font-medium ' +
                  (changeNote?.startsWith('Could not') ? 'text-red-700' : 'text-neutral-700')
                }
              >
                {changeNote ?? ''}
              </span>
            </div>
          )
        }
      >
        {!lot ? (
          <p className="px-5 py-6 text-sm text-neutral-500">Select a lot above.</p>
        ) : (
          <div className="px-5 pb-4">
            {/* The purchase context the registry table doesn't carry — on the
                page, not a click away, exactly as the old accordion had it. */}
            <p className="pt-3 text-xs text-neutral-500">
              <span className="font-medium text-neutral-700">{lot.batchNumber}</span>
              {' · '}PO {lot.purchaseOrder ?? '—'}
              {' · '}Received {lot.receivedDate ?? '—'}
              {' · '}Location {lot.location?.name ?? '—'}
              {lot.expectedUnitCount != null &&
                ` · ${scanned} of ${lot.expectedUnitCount} expected scanned`}
            </p>
            {/* Toolbar — everything the old accordion offered per lot, acting
                on the selected one. */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-200 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Stat label="Total" value={scanned} />
                <Stat label="Audited" value={lot.audited} tone={lot.audited > 0 ? 'emerald' : undefined} />
                <Stat label="Pending" value={pendingCount} tone={pendingCount > 0 ? 'amber' : undefined} />
                <Stat label="Unallocated" value={unallocated} />
                {missing != null && <Stat label="Missing" value={missing} tone={missing > 0 ? 'amber' : undefined} />}
                {extra != null && extra > 0 && <Stat label="Extra" value={extra} tone="red" />}
                <Stat label="Ready" value={lot.readyForSale} tone={lot.readyForSale > 0 ? 'emerald' : undefined} />
                {lot.scrap > 0 && <Stat label="Scrap" value={lot.scrap} tone="red" />}
                {lot.quarantine > 0 && <Stat label="Quarantine" value={lot.quarantine} tone="amber" />}
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-4">
                {isTarget ? (
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                    <Check className="size-3.5" aria-hidden="true" />
                    Audit target
                  </span>
                ) : (
                  <button
                    onClick={async () => {
                      await setAuditLot(lot.id);
                      router.refresh();
                    }}
                    className="text-xs font-medium text-neutral-500 hover:text-neutral-950"
                  >
                    Set audit target
                  </button>
                )}
                {canMove && unallocated > 0 && (
                  <TransferBatch
                    batchId={lot.id}
                    batchNumber={lot.batchNumber}
                    eligibleCount={unallocated}
                  />
                )}
                {canExport && (
                  <a
                    href={`/api/batches/${lot.id}/report`}
                    aria-label={`Export ${lot.batchNumber} to Excel`}
                    className="text-xs font-medium text-neutral-700 hover:text-neutral-950"
                  >
                    Export to Excel
                  </a>
                )}
                <Link
                  href={`/batches/${lot.id}`}
                  className="flex items-center gap-1 text-xs font-medium text-neutral-700 hover:text-neutral-950"
                >
                  Open lot
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
                {canDelete && (
                  <DeleteBatchButton
                    batchId={lot.id}
                    batchNumber={lot.batchNumber}
                    deviceCount={lot.totalUnitCount ?? lot.actualUnitCount}
                    soldCount={Math.max(0, (lot.totalUnitCount ?? 0) - lot.actualUnitCount)}
                    manifestLineCount={lot.expectedLineCount}
                    subLotCount={lot.subLotCount}
                  />
                )}
              </div>
            </div>

            {canMove && picked.length > 0 && (
              <MoveToPallet
                selectedIds={picked}
                onMoved={(outcome) => {
                  // Held out here because clearing `picked` unmounts the bar
                  // that produced this text — including its "N skipped" list.
                  setMoveOutcome(outcome);
                  setPicked([]);
                  // Refresh mode: the rows stay on screen through the reload,
                  // and the moved devices are reported as updated rather than
                  // the table blinking and looking untouched.
                  void loadUnits(lot.id, 'refresh');
                  router.refresh();
                }}
              />
            )}

            {moveOutcome && (
              <p
                role="status"
                className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-neutral-900"
              >
                {moveOutcome}
              </p>
            )}

            <div role="region" aria-label="Lot devices" tabIndex={0} className="mt-3 overflow-x-auto rounded-xl border border-neutral-200">
              {units.loading ? (
                <p role="status" className="px-4 py-4 text-sm text-neutral-500">Loading devices…</p>
              ) : units.error ? (
                <p role="alert" className="px-4 py-4 text-sm text-red-700">{units.error}</p>
              ) : shownUnits.length === 0 ? (
                <p className="px-4 py-4 text-sm text-neutral-500">
                  {units.assets.length === 0
                    ? 'No devices scanned into this lot yet.'
                    : 'No units match this filter.'}
                </p>
              ) : (
                <table className="w-full border-collapse text-left">
                  <caption className="sr-only">
                    Devices in {lot.batchNumber}. Selecting a row shows its captured hardware below.
                  </caption>
                  <thead className="bg-neutral-50">
                    <tr>
                      {canMove && (
                        <th scope="col" className={`${TH} w-8`}>
                          <input
                            type="checkbox"
                            aria-label="Select every unallocated device on this page"
                            checked={allPoolPicked}
                            ref={(el) => {
                              if (el)
                                el.indeterminate =
                                  picked.length > 0 && !allPoolPicked;
                            }}
                            // Union/subtract the PAGE's pool rather than
                            // replacing the whole selection: replacing was
                            // right when this checkbox covered every row, but
                            // with paging it silently discarded whatever was
                            // ticked on the other pages.
                            onChange={() =>
                              setPicked((prev) => {
                                const pageIds = poolShown.map((a) => a.id);
                                return allPoolPicked
                                  ? prev.filter((id) => !pageIds.includes(id))
                                  : [...new Set([...prev, ...pageIds])];
                              })
                            }
                            className="size-4 accent-[#1a6ef5]"
                          />
                        </th>
                      )}
                      <th scope="col" className={TH}>Unit ID</th>
                      <th scope="col" className={`${TH} hidden md:table-cell`}>Type</th>
                      <th scope="col" className={`${TH} hidden sm:table-cell`}>Manufacturer</th>
                      <th scope="col" className={TH}>Model</th>
                      <th scope="col" className={`${TH} hidden sm:table-cell`}>Serial No</th>
                      <th scope="col" className={TH}>Grade</th>
                      <th scope="col" className={TH}>Audit</th>
                      <th scope="col" className={`${TH} hidden md:table-cell`}>Stock</th>
                      <th scope="col" className={`${TH} hidden md:table-cell`}>Pallet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageUnits.map((a) => {
                      const isSel = a.id === selectedUnitId;
                      const grade = a.conditionGrade ? GRADE_LETTER[a.conditionGrade] : null;
                      return (
                        <tr
                          key={a.id}
                          className={
                            'border-t border-neutral-200 ' +
                            (isSel
                              ? 'border-l-4 border-l-[#1a6ef5] bg-blue-50/60'
                              : 'hover:bg-neutral-50')
                          }
                        >
                          {canMove && (
                            <td className={TD}>
                              {a.palletId ? (
                                <span className="sr-only">On a pallet — not movable from here</span>
                              ) : (
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${a.name} to move`}
                                  checked={picked.includes(a.id)}
                                  onChange={() =>
                                    setPicked((s) =>
                                      s.includes(a.id)
                                        ? s.filter((x) => x !== a.id)
                                        : [...s, a.id],
                                    )
                                  }
                                  className="size-4 accent-[#1a6ef5]"
                                />
                              )}
                            </td>
                          )}
                          <th scope="row" className={`${TD} font-mono text-xs`}>
                            {/* The unit number SELECTS (specs below); the full
                                record is one more click via its own page. */}
                            <button
                              onClick={() => void pickUnit(a.id)}
                              aria-label={`Show hardware for ${a.unitId ?? a.tag}`}
                              aria-current={isSel ? 'true' : undefined}
                              className="font-medium text-neutral-900 hover:text-[#1a6ef5]"
                            >
                              {a.unitId ?? a.tag}
                            </button>
                          </th>
                          <td className={`${TD} hidden text-neutral-600 md:table-cell`}>
                            {a.deviceType ?? a.category}
                          </td>
                          <td className={`${TD} hidden text-neutral-600 sm:table-cell`}>
                            {a.manufacturer ?? '—'}
                          </td>
                          <td className={TD}>
                            <Link
                              href={`/assets/${a.id}`}
                              className="text-[#1a6ef5] hover:underline"
                            >
                              {a.model ?? a.name}
                            </Link>
                          </td>
                          <td className={`${TD} hidden font-mono text-xs text-neutral-600 sm:table-cell`}>
                            {a.serialNumber ?? a.tag}
                          </td>
                          <td className={TD}>
                            {grade ? (
                              <span className="inline-flex min-w-7 items-center justify-center rounded border border-neutral-300 px-1.5 py-0.5 text-xs font-semibold text-neutral-800">
                                {grade}
                              </span>
                            ) : (
                              <span className="text-neutral-400">—</span>
                            )}
                          </td>
                          <td className={TD}>
                            {/* The actual verdict, toned like the /audit page —
                                a failed wipe reads red in full words, never a
                                generic green "Audited" with the truth in a
                                hover-only tooltip. */}
                            {a.auditStatus ? (
                              <span
                                className={`rounded-full border px-2 py-0.5 text-xs font-medium ${verdictClass(a.auditStatus)}`}
                              >
                                {formatLabel(a.auditStatus)}
                              </span>
                            ) : (
                              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                                Pending
                              </span>
                            )}
                          </td>
                          <td className={`${TD} hidden text-neutral-600 md:table-cell`}>
                            {formatLabel(a.stockStatus)}
                          </td>
                          <td className={`${TD} hidden md:table-cell`}>
                            {a.pallet ? (
                              <Link
                                href={`/pallets/${a.pallet.id}`}
                                className="text-neutral-700 underline hover:text-neutral-950"
                              >
                                {a.pallet.palletNumber}
                              </Link>
                            ) : (
                              <span className="text-neutral-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Says where you are before it offers to move you, and states the
                full count — otherwise a paged table looks like a short lot. */}
            {shownUnits.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-neutral-600" role="status">
                  Showing{' '}
                  <span className="font-medium text-neutral-900 tabular-nums">
                    {pageStart + 1}–{Math.min(pageStart + UNITS_PER_PAGE, shownUnits.length)}
                  </span>{' '}
                  of{' '}
                  <span className="font-medium text-neutral-900 tabular-nums">
                    {shownUnits.length}
                  </span>{' '}
                  {shownUnits.length === 1 ? 'device' : 'devices'}
                  {picked.length > 0 && (
                    <>
                      {' · '}
                      <span className="font-medium text-neutral-900 tabular-nums">
                        {picked.length}
                      </span>{' '}
                      selected across all pages
                    </>
                  )}
                </p>
                {pageCount > 1 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setUnitPage((n) => Math.max(1, n - 1))}
                      disabled={unitPage === 1}
                      className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-800 transition-colors hover:bg-neutral-50 disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <span className="text-xs text-neutral-600 tabular-nums">
                      Page {unitPage} of {pageCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => setUnitPage((n) => Math.min(pageCount, n + 1))}
                      disabled={unitPage === pageCount}
                      className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-800 transition-colors hover:bg-neutral-50 disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* ============ 3 · COMPONENT SPECS ============ */}
      <Panel
        id="panel-specs"
        title="Component Specs"
        subtitle={
          selectedUnit
            ? `Captured by the audit station for ${selectedUnit.unitId ?? selectedUnit.tag}`
            : 'Hardware captured at audit time'
        }
        open={openSpecs}
        onToggle={() => setOpenSpecs((v) => !v)}
        right={
          selectedUnit &&
          (selectedUnit.auditStatus ? (
            // Same verdict toning as the table: a failing verdict is red up
            // here too, never a reassuring green tick.
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-medium ${verdictClass(selectedUnit.auditStatus)}`}
            >
              {formatLabel(selectedUnit.auditStatus)}
            </span>
          ) : (
            <span className="text-xs text-neutral-500">Not audited yet</span>
          ))
        }
      >
        {!selectedUnit ? (
          <p className="px-5 py-6 text-sm text-neutral-500">
            Select a unit above to see its captured hardware.
          </p>
        ) : detail.loading ? (
          <p role="status" className="px-5 py-6 text-sm text-neutral-500">Loading hardware…</p>
        ) : detail.error ? (
          <p role="alert" className="px-5 py-6 text-sm text-red-700">{detail.error}</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-neutral-500">
            No hardware profile captured — this device was added by hand or scanned without the
            audit station.{' '}
            <Link href={`/assets/${selectedUnit.id}`} className="text-[#1a6ef5] hover:underline">
              Open its record →
            </Link>
          </p>
        ) : (
          // The same table the Audit workspace renders — one presentation of a
          // machine's components, wherever you meet it.
          <div className="px-5 pb-4">
            <ComponentSpecsTable
              rows={rows}
              caption={`Hardware components captured for ${selectedUnit.unitId ?? selectedUnit.tag}`}
            />
          </div>
        )}
      </Panel>

      {/* Slim status strip, as in the mockup. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-200 bg-neutral-50/60 px-4 py-2 text-xs text-neutral-500">
        <span>
          Logged in as: <span className="font-medium text-neutral-800">{viewer}</span>
        </span>
        <span>ALS Inventory</span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'amber' | 'red' | 'emerald';
}) {
  const cls =
    tone === 'amber'
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : tone === 'red'
        ? 'border-red-200 bg-red-50 text-red-700'
        : tone === 'emerald'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-neutral-200 bg-neutral-100 text-neutral-700';
  return (
    <span className={`rounded-md border px-2 py-0.5 font-medium ${cls}`}>
      {label} {value}
    </span>
  );
}
