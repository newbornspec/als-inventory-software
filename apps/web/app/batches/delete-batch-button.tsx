'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteBatch } from '@/lib/actions/batches';

// Delete a whole lot AND its contents. Unlike DeleteSubLotButton — which moves
// assets back to the parent — nothing here survives, so the confirmation spells
// out exactly what goes. Admin only; the caller decides whether to render it and
// the API enforces the role regardless.
//
// The counts are deliberately `number | undefined` rather than defaulting to 0.
// Web and API deploy independently, so a field the API does not send yet arrives
// as undefined — and "I don't know" must never be rendered as "there is none".
// Doing that is what let an earlier version tell an admin "this lot is empty"
// about a pre-arrival lot holding a 134-line supplier manifest.
export function DeleteBatchButton({
  batchId,
  batchNumber,
  // Sold-INCLUSIVE. The lot cards show actualUnitCount, which omits sold devices,
  // so a fully-sold lot displays 0 units while still holding a whole consignment.
  deviceCount,
  soldCount = 0,
  // REAL row counts, not the batch's hand-typed expectedUnitCount — that figure is
  // unrelated to how many manifest rows exist, so a lot can declare 500 and hold
  // none, or declare nothing and hold 300. Both are destroyed by the cascade.
  manifestLineCount,
  subLotCount,
  redirectTo,
}: {
  batchId: string;
  batchNumber: string;
  deviceCount: number;
  soldCount?: number;
  manifestLineCount?: number;
  subLotCount?: number;
  redirectTo?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function onDelete() {
    const consequences: string[] = [];

    if (deviceCount > 0) {
      consequences.push(
        deviceCount === 1
          ? '1 device will be permanently deleted, along with its audit history, data-wipe records and photos'
          : `${deviceCount} devices will be permanently deleted, along with their audit history, data-wipe records and photos`,
      );
    }
    if (soldCount > 0) {
      consequences.push(
        `${soldCount} of them ${soldCount === 1 ? 'is' : 'are'} already sold — their sale records and revenue history go too`,
      );
    }

    if (manifestLineCount === undefined || subLotCount === undefined) {
      // Counts unavailable (API older than this page). Warn without a number
      // rather than imply there is nothing attached.
      consequences.push(
        'any imported supplier manifest and any sub-lots will be removed with it',
      );
    } else {
      if (manifestLineCount > 0) {
        consequences.push(
          `the imported supplier manifest (${manifestLineCount} line${manifestLineCount === 1 ? '' : 's'}) will be removed, including which units were found, missing or mismatched`,
        );
      }
      if (subLotCount > 0) {
        consequences.push(
          `${subLotCount} sub-lot${subLotCount === 1 ? '' : 's'} and ${subLotCount === 1 ? 'its' : 'their'} declared specs will be removed`,
        );
      }
      // Only claimable once devices, manifest lines and sub-lots are all KNOWN to
      // be zero — never inferred from a missing value.
      if (consequences.length === 0) consequences.push('this lot is empty');
    }

    const message =
      `Are you sure you want to delete ${batchNumber}?\n\n` +
      consequences.map((c) => `• ${c}`).join('\n') +
      `\n\nThis cannot be undone.`;

    if (!window.confirm(message)) return;

    setError(null);
    startTransition(async () => {
      const res = await deleteBatch(batchId);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    });
  }

  return (
    <>
      <button
        onClick={onDelete}
        disabled={pending}
        className="font-medium text-red-600 transition-colors hover:text-red-700 disabled:opacity-50"
      >
        {pending ? 'Deleting…' : 'Delete lot'}
      </button>
      {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
    </>
  );
}
