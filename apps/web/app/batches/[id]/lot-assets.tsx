'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RotateCw } from 'lucide-react';
import type { Asset } from '@/lib/actions/assets';
import type { Lot } from '@/lib/actions/batches';
import { assignSubLot, moveAssetToBatch, deleteAssetFromLot } from '@/lib/actions/batches';
import { sellAsset } from '@/lib/actions/sold';
import { formatLabel } from '@/lib/asset-options';
import { MoveToPallet } from '../move-to-pallet';

// Every other list in the app pages at 50 (assets/page.tsx, activity/page.tsx).
// This table was the only one that rendered every row: a 500-device lot is a
// ~16,500px table, and with the sub-lot and Move-to selects mounted per row it
// is also tens of thousands of <option> nodes in one document.
const PAGE_SIZE = 50;

const TH =
  'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500';
const TD = 'px-4 py-3 text-left text-sm';

// A lot is full of devices with the same name. Any dialog that asks the operator
// to commit to one row has to identify THAT row, so lead with whatever actually
// distinguishes it — the unit ID, then the serial, then the tag.
function describe(a: Asset): string {
  const id = a.unitId || a.serialNumber || a.tag;
  return id && id !== a.name ? `${a.name} (${id})` : a.name;
}

// Level 2 of the hierarchy: the devices that belong to THIS purchase lot only.
// A clean, searchable table — drill into a row for the full hardware audit.
//
// Rendered by BOTH /batches/[id] and /batches/[id]/sublots/[lotId], so the words
// it says about its own contents have to come from the caller. They used to be
// hardcoded to "sub-lot", which on the lot page gave a search box visibly
// labelled "Search this lot" whose accessible name said "sub-lot" — a
// label-in-name mismatch that also breaks voice control.
export function LotAssets({
  assets,
  subLots,
  batchId,
  otherBatches,
  canManage,
  canDelete,
  canMove,
  scopeLabel = 'sub-lot',
}: {
  assets: Asset[];
  subLots: Lot[];
  batchId: string;
  otherBatches: { id: string; batchNumber: string; source: string | null }[];
  canManage: boolean;
  canDelete: boolean;
  canMove?: boolean;
  scopeLabel?: 'lot' | 'sub-lot';
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  // Ticked pool devices for Move to Pallet. Palletised rows are not tickable
  // -- they have already left the pool and show where they sit instead.
  const [selected, setSelected] = useState<string[]>([]);
  // Outcome of the last Move to Pallet, kept by the component that survives it.
  const [moveOutcome, setMoveOutcome] = useState<string | null>(null);
  const router = useRouter();

  // --- Refresh -----------------------------------------------------------
  // The audit station writes into this lot from a different machine, so the
  // page a technician is looking at goes stale the moment a unit is captured.
  // Refresh re-runs the server component (router.refresh()) rather than
  // re-rendering a cached payload, and then says WHAT arrived -- "audit a
  // device, press refresh, see it" is the whole workflow, and a button that
  // silently repaints the same table can't be told apart from a broken one.
  const [refreshing, startRefresh] = useTransition();
  const [lastLoaded, setLastLoaded] = useState<string | null>(null);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  // id -> the fields a fresh audit actually changes. Compared across loads.
  const prevSig = useRef<Map<string, string> | null>(null);
  const awaitingRefresh = useRef(false);

  useEffect(() => {
    const next = new Map(
      assets.map((a) => [
        a.id,
        [a.auditStatus ?? '', a.conditionGrade ?? '', a.stockStatus, a.palletId ?? ''].join('|'),
      ]),
    );
    const prev = prevSig.current;
    prevSig.current = next;
    // Rendered only after mount (and in the reader's own timezone), so the
    // server and client markup can't disagree.
    setLastLoaded(
      new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    );

    if (!prev || !awaitingRefresh.current) {
      awaitingRefresh.current = false;
      return;
    }
    awaitingRefresh.current = false;

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
  }, [assets]);

  function onRefresh() {
    setChangeNote(null);
    awaitingRefresh.current = true;
    startRefresh(() => router.refresh());
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return assets;
    return assets.filter((a) =>
      [
        a.unitId,
        a.name,
        a.manufacturer,
        a.model,
        a.deviceType,
        a.serialNumber,
        a.expressServiceCode,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle)),
    );
  }, [assets, q]);

  function onAssign(assetId: string, value: string) {
    startTransition(async () => {
      setError(null);
      // The <select> is controlled by the asset's own lotId, so a rejection
      // silently re-renders it back to the old value — indistinguishable from a
      // mis-click unless the failure is actually shown.
      const res = await assignSubLot(assetId, value || null, batchId);
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function onMove(asset: Asset, targetBatchId: string) {
    if (!targetBatchId) return;
    // Re-parenting a device changes its supplier, its cost basis and who can
    // see it, and clears its sub-lot in the same call — and it fired on a single
    // change event, so tabbing onto this select and pressing Down had already
    // moved the device. The activity line the API writes names only the
    // destination, so the original lot is not recoverable from the feed.
    const target = otherBatches.find((b) => b.id === targetBatchId);
    const label = describe(asset);
    if (
      !window.confirm(
        `Move ${label} to ${target?.batchNumber ?? 'another lot'}?\n\n` +
          `• it leaves this lot and its provenance moves with it\n` +
          `• its sub-lot grouping is cleared\n` +
          `• the activity log records the destination, not where it came from\n\n` +
          `Move it back by repeating this from the other lot.`,
      )
    )
      return;
    startTransition(async () => {
      setError(null);
      const res = await moveAssetToBatch(asset.id, targetBatchId, batchId);
      if (res.error) setError(res.error);
      router.refresh();
    });
  }

  // Sell straight from the lot table — the device leaves active inventory
  // (and this table), moves to the Sold page and locks.
  function onSell(asset: Asset) {
    if (
      !confirm(
        `Mark ${describe(asset)} as Sold? It will leave this lot's active inventory and lock — only an admin can return it.`,
      )
    )
      return;
    const raw = window.prompt('Sale price £ (optional — leave blank to skip)', '');
    const salePrice = raw && !isNaN(parseFloat(raw)) ? Math.max(0, parseFloat(raw)) : undefined;
    startTransition(async () => {
      setError(null);
      const res = await sellAsset(asset.id, salePrice);
      if (res.error) setError(res.error);
      router.refresh();
    });
  }

  function onDelete(asset: Asset) {
    // The old prompt carried only asset.name, which in an ITAD lot is routinely
    // identical down dozens of rows ("Dell Latitude 5420") — so it could not tell
    // the operator which of eight matching rows they had hit. It also named none
    // of what the cascade destroys, while the same deletion from the device's own
    // page spells all of it out.
    if (
      !window.confirm(
        `Delete ${describe(asset)}?\n\n` +
          `• it is removed from this lot and from the register\n` +
          `• its audit records — including any data-erasure evidence — are destroyed\n` +
          `• its photos and history go with it\n\n` +
          `This cannot be undone.`,
      )
    )
      return;
    startTransition(async () => {
      setError(null);
      const res = await deleteAssetFromLot(asset.id, batchId);
      if (res.error) setError(res.error);
      router.refresh();
    });
  }

  // A plain element, not a nested component: a component declared inside the
  // render would be a new type every pass and remount (losing the button's
  // focus mid-refresh).
  const refreshControl = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label={`Refresh this ${scopeLabel}'s devices`}
        className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[var(--control-border)] px-3 py-1.5 text-xs font-medium text-neutral-800 transition-colors hover:bg-neutral-50 disabled:opacity-60"
      >
        <RotateCw
          className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'}
          aria-hidden="true"
        />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
      <span className="text-xs text-neutral-500">
        {lastLoaded ? `Updated ${lastLoaded}` : ''}
      </span>
      {/* Only the outcome is live — the timestamp changes on every load and
          would otherwise be read out each time for no reason. */}
      <span aria-live="polite" className="text-xs font-medium text-neutral-700">
        {changeNote ?? ''}
      </span>
    </div>
  );

  if (assets.length === 0) {
    return (
      <div>
        <p className="text-sm text-neutral-600">
          No devices scanned into this {scopeLabel} yet — audit devices into it, or use Receiving
          mode on the Scan page.
        </p>
        {/* Deliberately still here: an empty lot is exactly when someone is
            standing at the audit station waiting for the first unit to land. */}
        <div className="mt-3">{refreshControl}</div>
      </div>
    );
  }

  // Derived from the same flags that render the headers, rather than a hand-kept
  // tally that counted a "Move to" column existing only when there is somewhere
  // to move to. Browsers clamp an over-large colspan, so nothing was visibly
  // wrong — this just stops the two from being able to drift.
  const showSubLotCol = canManage && subLots.length > 0;
  const showMoveCol = canManage && otherBatches.length > 0;
  const totalCols =
    (canMove ? 1 : 0) + // select
    11 + // Unit ID … Location
    (showSubLotCol ? 1 : 0) +
    (showMoveCol ? 1 : 0) +
    (canManage ? 1 : 0) + // Sell
    1 + // Print
    (canDelete ? 1 : 0);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const start = current * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  // Select-all applies to the whole filtered pool, not just the visible page —
  // paging must not quietly shrink what "all" means.
  const poolFiltered = filtered.filter((a) => !a.palletId);
  const allPoolSelected =
    poolFiltered.length > 0 && poolFiltered.every((a) => selected.includes(a.id));
  function toggleAllPool() {
    setSelected(allPoolSelected ? [] : poolFiltered.map((a) => a.id));
  }
  function toggleOne(id: string) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          aria-label={`Search devices in this ${scopeLabel}`}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
          placeholder={`Search this ${scopeLabel} — name, make, model, serial, service tag…`}
          className="field-underline w-full max-w-md px-3 py-1.5 text-sm"
        />
        <div className="flex flex-wrap items-center gap-3">
          <span className="shrink-0 text-xs text-neutral-600 tabular-nums">
            {filtered.length} of {assets.length}
          </span>
          {refreshControl}
        </div>
      </div>

      {canMove && selected.length > 0 && (
        <MoveToPallet
          selectedIds={selected}
          onMoved={(outcome) => {
            // Held here, not in MoveToPallet: clearing the selection unmounts
            // that bar, so anything it wrote to its own state went with it.
            setMoveOutcome(outcome);
            setSelected([]);
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

      <div
        role="region"
        aria-label={`Devices in this ${scopeLabel}`}
        tabIndex={0}
        aria-busy={pending}
        // `relative` is load-bearing: this table is far wider than a phone and
        // the action columns below carry sr-only headings, which Tailwind
        // implements as position:absolute. Without a positioned ancestor they
        // resolve against the initial containing block, land past the viewport at
        // the table's unscrolled width, and scroll the whole page sideways.
        className={
          'relative mt-3 min-w-0 overflow-x-auto rounded-lg border border-neutral-200 ' +
          (pending ? 'cursor-progress' : '')
        }
      >
        {/* Wide enough that fifteen columns are not crammed into the viewport —
            the container scrolls instead, which is what a device register with
            this many columns has to do. */}
        <table className="w-full min-w-[84rem] border-collapse text-left text-sm">
          <caption className="sr-only">Devices in this {scopeLabel}</caption>
          <thead className="bg-neutral-50">
            <tr>
              {canMove && (
                <th scope="col" className={`${TH} w-8`}>
                  <input
                    type="checkbox"
                    aria-label="Select all unallocated devices"
                    checked={allPoolSelected}
                    onChange={toggleAllPool}
                    disabled={poolFiltered.length === 0}
                    className="size-4 accent-[#1a6ef5]"
                  />
                </th>
              )}
              <th scope="col" className={TH}>Unit ID</th>
              <th scope="col" className={TH}>Name</th>
              <th scope="col" className={TH}>Manufacturer</th>
              <th scope="col" className={TH}>Model</th>
              <th scope="col" className={TH}>Type</th>
              <th scope="col" className={TH}>Serial</th>
              <th scope="col" className={TH}>Service tag</th>
              <th scope="col" className={TH}>Grade</th>
              <th scope="col" className={TH}>Audit</th>
              <th scope="col" className={TH}>Stock</th>
              <th scope="col" className={TH}>Location</th>
              {showSubLotCol && <th scope="col" className={TH}>Sub-lot</th>}
              {showMoveCol && <th scope="col" className={TH}>Move to</th>}
              {/* These three were empty cells, so a screen reader announced
                  nothing at all for the columns that act on a device. */}
              {canManage && (
                <th scope="col" className={TH}>
                  <span className="sr-only">Sell</span>
                </th>
              )}
              <th scope="col" className={TH}>
                <span className="sr-only">Print label</span>
              </th>
              {canDelete && (
                <th scope="col" className={TH}>
                  <span className="sr-only">Delete</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => (
              <tr key={a.id} className="border-t border-neutral-200 transition-colors hover:bg-neutral-50">
                {canMove && (
                  <td className={`${TD} w-8`}>
                    {a.palletId ? (
                      // Decorative filler only, so it stays aria-hidden: the
                      // absent checkbox is the real signal, and the row already
                      // announces its pallet chip and "On pallet". Nudged off
                      // neutral-300 (1.5:1) purely so it is visible.
                      <span aria-hidden="true" className="text-neutral-500">
                        —
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        aria-label={`Select ${describe(a)}`}
                        checked={selected.includes(a.id)}
                        onChange={() => toggleOne(a.id)}
                        className="size-4 accent-[#1a6ef5]"
                      />
                    )}
                  </td>
                )}
                <th
                  scope="row"
                  className={`${TD} whitespace-nowrap font-mono font-normal text-neutral-950`}
                >
                  {a.unitId || '—'}
                </th>
                <td className={`${TD} whitespace-nowrap`}>
                  <Link href={`/assets/${a.id}`} className="text-[#1a6ef5] hover:underline">
                    {a.name}
                  </Link>
                  {a.pallet && (
                    <Link
                      href={`/pallets/${a.pallet.id}`}
                      aria-label={`Open pallet ${a.pallet.palletNumber}`}
                      className="ml-2 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-800 hover:bg-blue-100"
                    >
                      {a.pallet.palletNumber}
                    </Link>
                  )}
                </td>
                <td className={`${TD} text-neutral-700`}>{a.manufacturer || '—'}</td>
                <td className={`${TD} text-neutral-700`}>{a.model || '—'}</td>
                <td className={`${TD} text-neutral-600`}>{a.deviceType || a.category || '—'}</td>
                <td className={`${TD} text-neutral-600`}>{a.serialNumber || '—'}</td>
                <td className={`${TD} text-neutral-600`}>{a.expressServiceCode || '—'}</td>
                <td className={`${TD} text-neutral-700`}>
                  {a.conditionGrade ? formatLabel(a.conditionGrade) : '—'}
                </td>
                <td className={`${TD} text-neutral-600`}>
                  {a.auditStatus ? formatLabel(a.auditStatus) : '—'}
                </td>
                <td className={`${TD} text-neutral-600`}>{formatLabel(a.stockStatus)}</td>
                <td className={`${TD} text-neutral-600`}>{a.location?.name || '—'}</td>

                {showSubLotCol && (
                  <td className={TD}>
                    <select
                      value={a.lotId ?? ''}
                      onChange={(e) => onAssign(a.id, e.target.value)}
                      disabled={pending}
                      className="field-inline max-w-[10rem] px-2 py-1 text-sm text-neutral-700"
                      aria-label={`Sub-lot for ${describe(a)}`}
                    >
                      <option value="">— None —</option>
                      {subLots.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.lotNumber}
                        </option>
                      ))}
                    </select>
                  </td>
                )}

                {showMoveCol && (
                  <td className={TD}>
                    {a.palletId ? (
                      // Relocating a lot out from under a pallet allocation is
                      // how provenance gets scrambled -- take it off the pallet
                      // first (admin action), then move it.
                      // neutral-400 was 2.5:1 on white; this is the only text
                      // explaining why the dropdown is missing on that row.
                      <span className="text-sm text-neutral-600">On pallet</span>
                    ) : (
                      <select
                        value=""
                        onChange={(e) => onMove(a, e.target.value)}
                        disabled={pending}
                        className="field-underline max-w-[10rem] px-2 py-1 text-sm text-neutral-700"
                        aria-label={`Move ${describe(a)} to another lot`}
                      >
                        <option value="">Move…</option>
                        {otherBatches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.batchNumber}
                            {b.source ? ` · ${b.source}` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                )}

                {canManage && (
                  <td className={TD}>
                    <button
                      type="button"
                      onClick={() => onSell(a)}
                      disabled={pending}
                      aria-label={`Sell ${describe(a)}`}
                      className="text-sm font-medium text-emerald-800 hover:underline disabled:opacity-50"
                    >
                      Sell
                    </button>
                  </td>
                )}

                <td className={TD}>
                  <Link
                    href={`/assets/${a.id}/label`}
                    target="_blank"
                    aria-label={`Print the label for ${describe(a)} (opens in a new tab)`}
                    className="text-sm text-[#1a6ef5] hover:underline"
                  >
                    Print
                  </Link>
                </td>

                {canDelete && (
                  <td className={TD}>
                    <button
                      type="button"
                      onClick={() => onDelete(a)}
                      disabled={pending}
                      aria-label={`Delete ${describe(a)}`}
                      className="text-sm font-medium text-red-700 hover:underline disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={totalCols} className="px-4 py-12 text-center text-sm text-neutral-600">
                  No devices match “{q}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-600">
        <span>
          Showing{' '}
          <span className="font-medium tabular-nums text-neutral-900">
            {filtered.length === 0 ? 0 : start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)}
          </span>{' '}
          of <span className="font-medium tabular-nums text-neutral-900">{filtered.length}</span>{' '}
          device{filtered.length === 1 ? '' : 's'}
          {selected.length > 0 && (
            <span className="ml-2 text-neutral-900">· {selected.length} selected</span>
          )}
        </span>
        {pageCount > 1 && (
          <span className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={current === 0}
              className="rounded-md border border-[var(--control-border)] px-2 py-1 text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="tabular-nums">
              Page {current + 1} of {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={current >= pageCount - 1}
              className="rounded-md border border-[var(--control-border)] px-2 py-1 text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
            >
              Next
            </button>
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
