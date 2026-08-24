'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteSubLot } from '@/lib/actions/batches';

// Delete a sub-lot. Assets it holds are returned to the parent lot (never
// deleted, via ON DELETE SET NULL on lot_id) — the confirmation says so when the
// bucket isn't empty.
//
// The count is deliberately the sold-INCLUSIVE one: every device pointing at
// this sub-lot is unhooked, so a bucket whose stock has already been sold would
// otherwise announce itself as empty while still holding a consignment.
export function DeleteSubLotButton({
  lotId,
  lotNumber,
  batchId,
  assetCount,
  redirectTo,
}: {
  lotId: string;
  lotNumber: string;
  batchId: string;
  assetCount: number;
  redirectTo?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function onDelete() {
    const message =
      assetCount > 0
        ? `Delete ${lotNumber}? Its ${assetCount} device${assetCount === 1 ? '' : 's'} will be moved back to the parent lot (not deleted).`
        : `Delete ${lotNumber}? This sub-lot is empty.`;
    if (!window.confirm(message)) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteSubLot(lotId, batchId);
      // Neither layer used to handle failure, and on the sub-lot page the
      // success path navigates away — so "did the page move?" was the only
      // feedback channel, and it stayed silent when the delete was rejected.
      if (res.error) {
        setError(res.error);
        return;
      }
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    });
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        // One "Delete" per sub-lot card meant every destructive control in the
        // list carried the identical accessible name.
        aria-label={`Delete sub-lot ${lotNumber}`}
        className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}
