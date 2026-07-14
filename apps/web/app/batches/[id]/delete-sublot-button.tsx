'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteSubLot } from '@/lib/actions/batches';

// Delete a sub-lot. Assets it holds are returned to the parent lot (never
// deleted) — the confirmation says so when the bucket isn't empty.
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
  const router = useRouter();

  function onDelete() {
    const message =
      assetCount > 0
        ? `Delete ${lotNumber}? Its ${assetCount} asset${assetCount === 1 ? '' : 's'} will be moved back to the parent lot (not deleted).`
        : `Delete ${lotNumber}? This sub-lot is empty.`;
    if (!window.confirm(message)) return;
    startTransition(async () => {
      await deleteSubLot(lotId, batchId);
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    });
  }

  return (
    <button
      onClick={onDelete}
      disabled={pending}
      className="rounded-md border border-red-900 px-2 py-0.5 text-xs text-red-400 hover:bg-red-950 disabled:opacity-50"
    >
      {pending ? 'Deleting…' : 'Delete'}
    </button>
  );
}
