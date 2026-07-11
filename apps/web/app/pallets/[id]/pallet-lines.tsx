'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addPalletLine,
  updatePalletLine,
  deletePalletLine,
  type PalletLine,
} from '@/lib/actions/pallets';

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
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!variant.trim()) {
      setError('Enter a variant.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await addPalletLine(palletId, variant, parseInt(qty || '0', 10));
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setVariant('');
    setQty('');
    router.refresh();
  }

  async function saveQty(line: PalletLine, next: number) {
    if (Number.isNaN(next) || next === line.quantity) return;
    await updatePalletLine(palletId, line.id, line.variant, next);
    router.refresh();
  }

  async function remove(line: PalletLine) {
    await deletePalletLine(palletId, line.id);
    router.refresh();
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-900 text-neutral-400">
          <tr>
            <th className="px-3 py-2">Variant / size</th>
            <th className="w-32 px-3 py-2">Quantity</th>
            {canManage && <th className="w-16 px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-neutral-800">
              <td className="px-3 py-2 text-neutral-200">{l.variant}</td>
              <td className="px-3 py-2">
                {canManage ? (
                  <input
                    type="number"
                    min={0}
                    defaultValue={l.quantity}
                    onBlur={(e) => saveQty(l, parseInt(e.target.value || '0', 10))}
                    className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                  />
                ) : (
                  l.quantity
                )}
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
              <td colSpan={canManage ? 3 : 2} className="px-3 py-6 text-center text-neutral-500">
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
                  type="number"
                  min={0}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="20"
                  className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
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
