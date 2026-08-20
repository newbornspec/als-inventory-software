'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Asset } from '@/lib/actions/assets';
import type { Lot } from '@/lib/actions/batches';
import { assignSubLot, moveAssetToBatch, deleteAssetFromLot } from '@/lib/actions/batches';
import { sellAsset } from '@/lib/actions/sold';
import { formatLabel } from '@/lib/asset-options';

// Level 2 of the hierarchy: the devices that belong to THIS purchase lot only.
// A clean, searchable table — drill into a row for the full hardware audit.
export function LotAssets({
  assets,
  subLots,
  batchId,
  otherBatches,
  canManage,
  canDelete,
}: {
  assets: Asset[];
  subLots: Lot[];
  batchId: string;
  otherBatches: { id: string; batchNumber: string; source: string | null }[];
  canManage: boolean;
  canDelete: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const router = useRouter();

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

  if (assets.length === 0) {
    return (
      <p className="mt-3 text-sm text-neutral-500">
        No assets scanned into this lot yet — audit devices into it, or use Receiving mode on the
        Scan page.
      </p>
    );
  }

  const actionCols =
    (canManage ? 2 : 0) + (canDelete ? 1 : 0) + (canManage && subLots.length > 0 ? 1 : 0);
  // 10 data columns + Unit ID + the always-present Print column.
  const totalCols = 12 + actionCols;

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-3">
        <input
          aria-label="Search devices in this sub-lot"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search this lot — name, make, model, serial, service tag…"
          className="field-underline w-full max-w-md px-3 py-1.5 text-sm"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {filtered.length} of {assets.length}
        </span>
      </div>

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
                <td className="px-3 py-2 font-mono text-neutral-950">{a.unitId || '—'}</td>
                <td className="px-3 py-2">
                  <Link href={`/assets/${a.id}`} className="text-neutral-950 underline">
                    {a.name}
                  </Link>
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
