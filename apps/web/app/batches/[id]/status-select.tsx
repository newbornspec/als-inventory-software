'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateBatchStatus } from '@/lib/actions/batches';
import { sellBatch } from '@/lib/actions/sold';
import { formatLabel } from '@/lib/asset-options';

const BATCH_STATUSES = ['draft', 'awaiting_arrival', 'open', 'receiving', 'closed', 'reconciled', 'sold'];

export function BatchStatusSelect({
  batchId,
  status,
  // Live devices in the lot — what choosing "Sold" would actually sell.
  unitsAtRisk,
}: {
  batchId: string;
  status: string;
  unitsAtRisk: number;
}) {
  const router = useRouter();
  const selectRef = useRef<HTMLSelectElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Choosing "Sold" is more than a label: it sells the whole lot (every
  // remaining device is marked Sold and locked) — so it confirms first and
  // goes through the sell endpoint, not the plain status update.
  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    setNote(null);
    if (next !== 'sold') {
      setError(null);
      setBusy(true);
      const data = new FormData();
      data.set('status', next);
      const res = await updateBatchStatus(batchId, data);
      setBusy(false);
      if (res.error) {
        setError(res.error);
        if (selectRef.current) selectRef.current.value = status;
        return;
      }
      router.refresh();
      return;
    }
    // This is the page's largest mutation and it used to quantify nothing —
    // selling 60 devices and selling 0 read identically. The count is right
    // here on the page, so say it.
    if (unitsAtRisk === 0) {
      setError('There are no live devices in this lot to sell.');
      if (selectRef.current) selectRef.current.value = status;
      return;
    }
    if (
      !confirm(
        `Sell all ${unitsAtRisk} device${unitsAtRisk === 1 ? '' : 's'} still in this lot?\n\n` +
          `• each one is marked Sold and leaves active inventory\n` +
          `• each one locks — only an admin can return it\n` +
          `• the lot's devices move to the Sold archive\n\n` +
          `This is not the same as closing the lot.`,
      )
    ) {
      if (selectRef.current) selectRef.current.value = status; // revert the picker
      return;
    }
    const raw = window.prompt(
      `Total sale price for all ${unitsAtRisk} devices £ (optional — split evenly per device; leave blank to skip)`,
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
    // sellBatch returns how many it actually sold; the handler used to discard
    // it, so nothing on the page confirmed the scale of what just happened.
    const sold = res.soldCount;
    setNote(
      sold == null
        ? 'Lot sold.'
        : `Sold ${sold} device${sold === 1 ? '' : 's'} out of this lot.`,
    );
    router.refresh();
  }

  return (
    <form>
      <select
        ref={selectRef}
        name="status"
        aria-label="Lot status"
        defaultValue={status}
        disabled={busy}
        onChange={onChange}
        className="field-inline px-2 py-1 text-sm disabled:opacity-50"
      >
        {BATCH_STATUSES.map((s) => (
          <option key={s} value={s} className="bg-white">
            {formatLabel(s)}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
      {note && (
        <p role="status" className="mt-1 text-xs text-emerald-800">
          {note}
        </p>
      )}
    </form>
  );
}
