'use client';

import { useState } from 'react';
import { transferBatchToPallet } from '@/lib/actions/pallets';

// The batch-level quick path (client spec: Goods In -> Transfer Entire
// Batch): one button, one confirmation, and every eligible device in the lot
// moves onto a brand-new auto-numbered pallet. The per-item checkboxes remain
// for partial moves — this exists so nobody ticks 22 boxes to move 22 items.
export function TransferBatch({
  batchId,
  batchNumber,
  eligibleCount,
}: {
  batchId: string;
  batchNumber: string;
  eligibleCount: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [nextNumber, setNextNumber] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openConfirm() {
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch('/api/pallets/next-number');
      const data = res.ok ? await res.json() : null;
      setNextNumber(data?.palletNumber ?? data?.nextNumber ?? null);
    } catch {
      setNextNumber(null);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    // On success the action redirects straight to the new pallet's page —
    // the spec's "show the newly created pallet". Only failures return here.
    const result = await transferBatchToPallet(batchId);
    setBusy(false);
    if (result?.error) setError(result.error);
  }

  if (!confirming) {
    return (
      <button
        onClick={openConfirm}
        className="font-medium text-[#1a6ef5] transition-colors hover:text-blue-800"
      >
        Transfer to pallet
      </button>
    );
  }

  return (
    <div className="mt-3 w-full rounded-xl border border-blue-200 bg-blue-50 p-4 text-left">
      <p className="text-sm font-semibold text-neutral-950">Create new pallet</p>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-neutral-500">Source</dt>
          <dd className="font-medium">{batchNumber}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Items to transfer</dt>
          <dd className="font-medium">
            {eligibleCount} serialized item{eligibleCount === 1 ? '' : 's'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">New pallet</dt>
          <dd className="font-medium">
            {nextNumber ? `${nextNumber} (next available)` : 'Number generated automatically'}
          </dd>
        </div>
      </dl>
      <p className="mt-2 max-w-2xl text-xs text-neutral-600">
        Their serialized details, audit history and Goods In origin are preserved — the devices
        move, they are not copied. After the transfer they leave this lot&rsquo;s active pool and
        the pallet becomes their current location. Moving them back later is an admin action.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-white disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={confirm}
          disabled={busy || eligibleCount === 0}
          className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Transferring…' : 'Create pallet & transfer'}
        </button>
      </div>
    </div>
  );
}
