'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateBatchStatus } from '@/lib/actions/batches';
import { sellBatch } from '@/lib/actions/sold';
import { formatLabel } from '@/lib/asset-options';

const BATCH_STATUSES = ['draft', 'awaiting_arrival', 'open', 'receiving', 'closed', 'reconciled', 'sold'];

export function BatchStatusSelect({ batchId, status }: { batchId: string; status: string }) {
  const router = useRouter();
  const selectRef = useRef<HTMLSelectElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boundUpdate = updateBatchStatus.bind(null, batchId);

  // Choosing "Sold" is more than a label: it sells the whole lot (every
  // remaining device is marked Sold and locked) — so it confirms first and
  // goes through the sell endpoint, not the plain status update.
  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    if (next !== 'sold') {
      e.currentTarget.form?.requestSubmit();
      return;
    }
    if (
      !confirm(
        'Sell this whole lot? Every remaining device in it will be marked Sold, leave active inventory and lock — only an admin can return them.',
      )
    ) {
      if (selectRef.current) selectRef.current.value = status; // revert the picker
      return;
    }
    const raw = window.prompt(
      'Total sale price for the lot £ (optional — split evenly per device; leave blank to skip)',
      '',
    );
    const saleTotal = raw && !isNaN(parseFloat(raw)) ? Math.max(0, parseFloat(raw)) : undefined;
    setBusy(true);
    setError(null);
    const res = await sellBatch(batchId, saleTotal);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      if (selectRef.current) selectRef.current.value = status;
      return;
    }
    router.refresh();
  }

  return (
    <form action={boundUpdate}>
      <select
        ref={selectRef}
        name="status"
        defaultValue={status}
        disabled={busy}
        onChange={onChange}
        className="w-full bg-transparent text-lg font-semibold disabled:opacity-50"
      >
        {BATCH_STATUSES.map((s) => (
          <option key={s} value={s} className="bg-neutral-900">
            {formatLabel(s)}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </form>
  );
}
