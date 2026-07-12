'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addPalletLine,
  updatePalletLine,
  deletePalletLine,
  type PalletLine,
} from '@/lib/actions/pallets';
import { money } from '@/lib/money';

export function PalletLines({
  palletId,
  lines,
  canManage,
}: {
  palletId: string;
  lines: PalletLine[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [variant, setVariant] = useState('');
  const [supplier, setSupplier] = useState('');
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!variant.trim()) {
      setError('Enter a variant.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await addPalletLine(
      palletId,
      variant,
      parseInt(qty || '0', 10),
      cost ? parseFloat(cost) : null,
      supplier,
    );
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setVariant('');
    setSupplier('');
    setQty('');
    setCost('');
    router.refresh();
  }

  // Run a line mutation and surface any failure instead of silently swallowing
  // it — a stale session (expired token) is the usual cause and must be visible.
  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch {
      setError(
        'Couldn’t save that change — your session may have expired. Refresh the page and sign in, then try again.',
      );
    }
  }

  // Each field saves on blur, carrying the line's other current values so an
  // edit to one field never wipes the others — this is the per-item "edit".
  function saveVariant(line: PalletLine, next: string) {
    if (!next.trim() || next.trim() === line.variant) return;
    void run(() =>
      updatePalletLine(palletId, line.id, next, line.quantity, line.unitCost, line.supplier ?? ''),
    );
  }
  function saveSupplier(line: PalletLine, next: string) {
    if (next.trim() === (line.supplier ?? '')) return;
    void run(() =>
      updatePalletLine(palletId, line.id, line.variant, line.quantity, line.unitCost, next),
    );
  }
  function saveQty(line: PalletLine, next: number) {
    if (Number.isNaN(next) || next === line.quantity) return;
    void run(() =>
      updatePalletLine(palletId, line.id, line.variant, next, line.unitCost, line.supplier ?? ''),
    );
  }
  function saveCost(line: PalletLine, next: number | null) {
    if (next === line.unitCost) return;
    void run(() =>
      updatePalletLine(palletId, line.id, line.variant, line.quantity, next, line.supplier ?? ''),
    );
  }
  function remove(line: PalletLine) {
    void run(() => deletePalletLine(palletId, line.id));
  }

  const cols = canManage ? 6 : 5;

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-900 text-neutral-400">
          <tr>
            <th className="px-3 py-2">Variant / size</th>
            <th className="px-3 py-2">Supplier</th>
            <th className="w-24 px-3 py-2">Quantity</th>
            <th className="w-28 px-3 py-2">Unit cost (£)</th>
            <th className="w-24 px-3 py-2">Line total</th>
            {canManage && <th className="w-16 px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-neutral-800">
              <td className="px-3 py-2">
                {canManage ? (
                  <input
                    defaultValue={l.variant}
                    onBlur={(e) => saveVariant(l, e.target.value)}
                    className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                  />
                ) : (
                  <span className="text-neutral-200">{l.variant}</span>
                )}
              </td>
              <td className="px-3 py-2">
                {canManage ? (
                  <input
                    defaultValue={l.supplier ?? ''}
                    placeholder="—"
                    onBlur={(e) => saveSupplier(l, e.target.value)}
                    className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                  />
                ) : (
                  <span className="text-neutral-400">{l.supplier || '—'}</span>
                )}
              </td>
              <td className="px-3 py-2">
                {canManage ? (
                  <input
                    type="number"
                    min={0}
                    defaultValue={l.quantity}
                    onBlur={(e) => saveQty(l, parseInt(e.target.value || '0', 10))}
                    className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                  />
                ) : (
                  l.quantity
                )}
              </td>
              <td className="px-3 py-2">
                {canManage ? (
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    defaultValue={l.unitCost ?? ''}
                    placeholder="—"
                    onBlur={(e) => saveCost(l, e.target.value ? parseFloat(e.target.value) : null)}
                    className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                  />
                ) : l.unitCost != null ? (
                  money(l.unitCost)
                ) : (
                  '—'
                )}
              </td>
              <td className="px-3 py-2 text-neutral-300">
                {l.unitCost != null ? money(l.unitCost * l.quantity) : '—'}
              </td>
              {canManage && (
                <td className="px-3 py-2">
                  <button onClick={() => remove(l)} className="text-xs text-red-400 hover:underline">
                    Remove
                  </button>
                </td>
              )}
            </tr>
          ))}
          {lines.length === 0 && (
            <tr>
              <td colSpan={cols} className="px-3 py-6 text-center text-neutral-500">
                No variants added yet.
              </td>
            </tr>
          )}
        </tbody>
        {canManage && (
          <tfoot>
            <tr className="border-t border-neutral-800 bg-neutral-900/40">
              <td className="px-3 py-2">
                <input
                  value={variant}
                  onChange={(e) => setVariant(e.target.value)}
                  placeholder="e.g. 22 inch"
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
              <td className="px-3 py-2">
                <input
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  placeholder="supplier (optional)"
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  min={0}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="20"
                  className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="optional"
                  className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2">
                <button
                  onClick={add}
                  disabled={busy}
                  className="rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
                >
                  {busy ? '…' : 'Add'}
                </button>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
