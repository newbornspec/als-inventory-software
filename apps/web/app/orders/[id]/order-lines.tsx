'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addOrderLine,
  updateOrderLine,
  deleteOrderLine,
  type OrderLine,
} from '@/lib/actions/sales';
import { money } from '@/lib/money';

export function OrderLines({
  orderId,
  lines,
  canManage,
}: {
  orderId: string;
  lines: OrderLine[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!desc.trim()) {
      setError('Enter a description.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await addOrderLine(
      orderId,
      desc,
      parseInt(qty || '1', 10),
      price ? parseFloat(price) : null,
    );
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setDesc('');
    setQty('1');
    setPrice('');
    router.refresh();
  }

  async function saveQty(line: OrderLine, q: number) {
    if (Number.isNaN(q) || q === line.quantity) return;
    await updateOrderLine(orderId, line.id, q, line.unitPrice);
    router.refresh();
  }
  async function savePrice(line: OrderLine, p: number | null) {
    if (p === line.unitPrice) return;
    await updateOrderLine(orderId, line.id, line.quantity, p);
    router.refresh();
  }
  async function remove(line: OrderLine) {
    await deleteOrderLine(orderId, line.id);
    router.refresh();
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-900 text-neutral-400">
          <tr>
            <th className="px-3 py-2">Item</th>
            <th className="w-20 px-3 py-2">Qty</th>
            <th className="w-28 px-3 py-2">Unit price</th>
            <th className="w-24 px-3 py-2">Line total</th>
            {canManage && <th className="w-16 px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-neutral-800">
              <td className="px-3 py-2 text-neutral-200">
                {l.asset ? `${l.asset.tag} — ${l.asset.name}` : l.description}
              </td>
              <td className="px-3 py-2">
                {canManage && !l.asset ? (
                  <input
                    type="number"
                    min={1}
                    defaultValue={l.quantity}
                    onBlur={(e) => saveQty(l, parseInt(e.target.value || '1', 10))}
                    className="w-16 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
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
                    defaultValue={l.unitPrice ?? ''}
                    onBlur={(e) => savePrice(l, e.target.value ? parseFloat(e.target.value) : null)}
                    className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                  />
                ) : (
                  money(l.unitPrice)
                )}
              </td>
              <td className="px-3 py-2 text-neutral-300">
                {money((l.unitPrice ?? 0) * l.quantity)}
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
              <td colSpan={canManage ? 5 : 4} className="px-3 py-6 text-center text-neutral-500">
                No line items yet.
              </td>
            </tr>
          )}
        </tbody>
        {canManage && (
          <tfoot>
            <tr className="border-t border-neutral-800 bg-neutral-900/40">
              <td className="px-3 py-2">
                <input
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="e.g. Dell Latitude 7490"
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="w-16 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
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
