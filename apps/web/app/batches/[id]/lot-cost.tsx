'use client';

import { useActionState } from 'react';
import { updateBatchCost } from '@/lib/actions/batches';
import type { ActionState } from '@/lib/actions/assets';

// What the whole lot cost — the basis for per-unit allocation and margin
// reporting. It had no pending, error or success state at all, so a rejected
// save was indistinguishable from a successful one; and blanking the field used
// to send `undefined`, which JSON.stringify drops, so a cost booked against the
// wrong consignment could never be removed. Both are fixed here and in the
// action.
export function LotCost({ batchId, totalCost }: { batchId: string; totalCost: number | null }) {
  const bound = updateBatchCost.bind(null, batchId);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(bound, {
    error: null,
  });

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <span className="text-neutral-500">£</span>
      <input
        name="totalCost"
        aria-label="Lot cost in pounds — leave blank to clear it"
        type="number"
        min={0}
        step="0.01"
        defaultValue={totalCost ?? ''}
        placeholder="lot cost"
        disabled={pending}
        className="field-inline w-28 px-2 py-1 text-sm disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={pending}
        className="field-inline px-2 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
      {state.error && (
        <span role="alert" className="text-xs text-red-700">
          {state.error}
        </span>
      )}
    </form>
  );
}
