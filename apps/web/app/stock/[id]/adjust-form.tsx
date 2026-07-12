'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { adjustStock, type StockMovementReason } from '@/lib/actions/stock';
import { formatLabel } from '@/lib/asset-options';

const REASONS: StockMovementReason[] = ['received', 'used', 'adjusted', 'returned', 'scrapped'];

export function AdjustStock({ lineId }: { lineId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<StockMovementReason>('received');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(sign: 1 | -1) {
    const amt = parseInt(amount || '0', 10);
    if (!amt || amt <= 0) {
      setError('Enter a positive amount.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await adjustStock(lineId, sign * amt, reason, note);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setAmount('');
    setNote('');
    router.refresh();
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-800 p-4">
      <div className="grid grid-cols-2 gap-3">
        <input
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value as StockMovementReason)}
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {formatLabel(r)}
            </option>
          ))}
        </select>
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
      />
      <div className="flex gap-2">
        <button
          onClick={() => apply(1)}
          disabled={busy}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          + Add
        </button>
        <button
          onClick={() => apply(-1)}
          disabled={busy}
          className="rounded-md border border-red-800 px-3 py-1.5 text-sm font-medium text-red-300 disabled:opacity-50"
        >
          − Remove
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
