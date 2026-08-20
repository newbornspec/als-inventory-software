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
    <div className="space-y-3 rounded-lg border border-neutral-200 p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          type="number"
          min={1}
          aria-label="Amount to adjust by"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          className="field-underline w-full px-3 py-2 text-sm"
        />
        <select
          aria-label="Reason for the adjustment"
          value={reason}
          onChange={(e) => setReason(e.target.value as StockMovementReason)}
          className="field-underline w-full px-3 py-2 text-sm"
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {formatLabel(r)}
            </option>
          ))}
        </select>
      </div>
      <input
        aria-label="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="field-underline w-full px-3 py-2 text-sm"
      />
      <div className="flex gap-2">
        <button
          onClick={() => apply(1)}
          disabled={busy}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          + Add
        </button>
        <button
          onClick={() => apply(-1)}
          disabled={busy}
          className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 disabled:opacity-50"
        >
          − Remove
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
