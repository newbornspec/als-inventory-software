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

// Level 2 of the hierarchy: the devices that belong to THIS purchase lot only.
// A clean, searchable table — drill into a row for the full hardware audit.
export function LotAssets({
  assets,
  subLots,
  batchId,
  otherBatches,
  canManage,
  canDelete,
  canMove,
}: {
  assets: Asset[];
  subLots: Lot[];
  batchId: string;
  otherBatches: { id: string; batchNumber: string; source: string | null }[];
  canManage: boolean;
  canDelete: boolean;
  canMove?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Ticked pool devices for Move to Pallet. Palletised rows are not tickable
  // -- they have already left the pool and show where they sit instead.
  const [selected, setSelected] = useState<string[]>([]);
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
      await assignSubLot(assetId, value || null, batchId);
      router.refresh();
    });
  }

  function onMove(assetId: string, targetBatchId: string) {
    if (!targetBatchId) return;
    startTransition(async () => {
      setError(null);
      const res = await moveAssetToBatch(assetId, targetBatchId, batchId);
      if (res.error) setError(res.error);
      router.refresh();
    });
  }

  // Sell straight from the lot table — the device leaves active inventory
  // (and this table), moves to the Sold page and locks.
  function onSell(asset: Asset) {
    if (
      !confirm(
        `Mark "${asset.name}" as Sold? It will leave this lot's active inventory and lock — only an admin can return it.`,
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
    if (!confirm(`Delete "${asset.name}"? This permanently removes the device and its audit history.`))
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
        aria-label="Refresh this lot's devices"
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
      <div className="mt-3">
        <p className="text-sm text-neutral-500">
          No assets scanned into this lot yet — audit devices into it, or use Receiving mode on the
          Scan page.
        </p>
        {/* Deliberately still here: an empty lot is exactly when someone is
            standing at the audit station waiting for the first unit to land. */}
        <div className="mt-3">{refreshControl}</div>
      </div>
    );
  }

  const actionCols =
    (canManage ? 2 : 0) + (canDelete ? 1 : 0) + (canManage && subLots.length > 0 ? 1 : 0);
  // 10 data columns + Unit ID + the always-present Print column.
  const totalCols = 12 + actionCols + (canMove ? 1 : 0);

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
    <div className="mt-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          aria-label="Search devices in this sub-lot"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search this lot — name, make, model, serial, service tag…"
          className="field-underline w-full max-w-md px-3 py-1.5 text-sm"
        />
        <div className="flex flex-wrap items-center gap-3">
          <span className="shrink-0 text-xs text-neutral-500">
            {filtered.length} of {assets.length}
          </span>
          {refreshControl}
        </div>
      </div>

      {canMove && selected.length > 0 && (
        <MoveToPallet
          selectedIds={selected}
          onMoved={() => {
            setSelected([]);
            router.refresh();
          }}
        />
      )}

      <div
        role="region"
        aria-label="Devices in this lot"
        tabIndex={0}
        aria-busy={pending}
        className={
          'mt-3 overflow-x-auto rounded-lg border border-neutral-200 ' +
          (pending ? 'cursor-progress' : '')
        }
      >
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Devices in this sub-lot</caption>
          <thead className="bg-neutral-50 text-neutral-500">
            <tr>
              {canMove && (
                <th scope="col" className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all unallocated devices"
                    checked={allPoolSelected}
                    onChange={toggleAllPool}
                    disabled={poolFiltered.length === 0}
                  />
                </th>
              )}
              <th scope="col" className="px-3 py-2">Unit ID</th>
              <th scope="col" className="px-3 py-2">Name</th>
              <th scope="col" className="px-3 py-2">Manufacturer</th>
              <th scope="col" className="px-3 py-2">Model</th>
              <th scope="col" className="px-3 py-2">Type</th>
              <th scope="col" className="px-3 py-2">Serial</th>
              <th scope="col" className="px-3 py-2">Service tag</th>
              <th scope="col" className="px-3 py-2">Grade</th>
              <th scope="col" className="px-3 py-2">Audit</th>
              <th scope="col" className="px-3 py-2">Stock</th>
              <th scope="col" className="px-3 py-2">Location</th>
              {canManage && subLots.length > 0 && <th scope="col" className="px-3 py-2">Sub-lot</th>}
              {canManage && otherBatches.length > 0 && <th scope="col" className="px-3 py-2">Move to</th>}
              {canManage && <th scope="col" className="px-3 py-2" />}
              <th scope="col" className="px-3 py-2" />
              {canDelete && <th scope="col" className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.id} className="border-t border-neutral-200 hover:bg-neutral-50">
                {canMove && (
                  <td className="w-8 px-3 py-2">
                    {a.palletId ? (
                      <span aria-hidden="true" className="text-neutral-300">—</span>
                    ) : (
                      <input
                        type="checkbox"
                        aria-label={`Select ${a.name}`}
                        checked={selected.includes(a.id)}
                        onChange={() => toggleOne(a.id)}
                      />
                    )}
                  </td>
                )}
                <td className="px-3 py-2 font-mono text-neutral-950">{a.unitId || '—'}</td>
                <td className="px-3 py-2">
                  <Link href={`/assets/${a.id}`} className="text-neutral-950 underline">
                    {a.name}
                  </Link>
                  {a.pallet && (
                    <Link
                      href={`/pallets/${a.pallet.id}`}
                      className="ml-2 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 hover:bg-blue-100"
                    >
                      {a.pallet.palletNumber}
                    </Link>
                  )}
                </td>
                <td className="px-3 py-2 text-neutral-700">{a.manufacturer || '—'}</td>
                <td className="px-3 py-2 text-neutral-700">{a.model || '—'}</td>
                <td className="px-3 py-2 text-neutral-500">{a.deviceType || a.category || '—'}</td>
                <td className="px-3 py-2 text-neutral-500">{a.serialNumber || '—'}</td>
                <td className="px-3 py-2 text-neutral-500">{a.expressServiceCode || '—'}</td>
                <td className="px-3 py-2 text-neutral-700">
                  {a.conditionGrade ? formatLabel(a.conditionGrade) : '—'}
                </td>
                <td className="px-3 py-2 text-neutral-500">
                  {a.auditStatus ? formatLabel(a.auditStatus) : '—'}
                </td>
                <td className="px-3 py-2 text-neutral-500">{formatLabel(a.stockStatus)}</td>
                <td className="px-3 py-2 text-neutral-500">{a.location?.name || '—'}</td>

                {canManage && subLots.length > 0 && (
                  <td className="px-3 py-2">
                    <select
                      value={a.lotId ?? ''}
                      onChange={(e) => onAssign(a.id, e.target.value)}
                      disabled={pending}
                      className="field-inline max-w-[10rem] px-2 py-1 text-xs text-neutral-700"
                      aria-label={`Sub-lot for ${a.name}`}
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

                {canManage && otherBatches.length > 0 && (
                  <td className="px-3 py-2">
                    {a.palletId ? (
                      // Relocating a lot out from under a pallet allocation is
                      // how provenance gets scrambled -- take it off the pallet
                      // first (admin action), then move it.
                      <span className="text-xs text-neutral-400">On pallet</span>
                    ) : (
                    <select
                      value=""
                      onChange={(e) => onMove(a.id, e.target.value)}
                      disabled={pending}
                      className="field-underline max-w-[10rem] px-2 py-1 text-xs text-neutral-700"
                      aria-label={`Move ${a.name} to another lot`}
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
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onSell(a)}
                      disabled={pending}
                      aria-label={`Sell ${a.tag}`}
                      className="text-emerald-800 hover:underline"
                    >
                      Sell
                    </button>
                  </td>
                )}

                <td className="px-3 py-2">
                  <Link
                    href={`/assets/${a.id}/label`}
                    target="_blank"
                    aria-label={`Print the label for ${a.tag} (opens in a new tab)`}
                    className="text-[#1a6ef5] hover:underline"
                  >
                    Print
                  </Link>
                </td>

                {canDelete && (
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onDelete(a)}
                      disabled={pending}
                      aria-label={`Delete ${a.tag}`}
                      className="text-red-700 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={totalCols} className="px-3 py-6 text-center text-neutral-500">
                  No assets match “{q}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
