'use client';

import { updateBatchCost } from '@/lib/actions/batches';

export function LotCost({ batchId, totalCost }: { batchId: string; totalCost: number | null }) {
  const boundUpdate = updateBatchCost.bind(null, batchId);
  return (
    <form action={boundUpdate} className="flex items-center gap-2">
      <span className="text-neutral-500">£</span>
      <input
        name="totalCost"
        aria-label="Lot cost in pounds"
        type="number"
        min={0}
        step="0.01"
        defaultValue={totalCost ?? ''}
        placeholder="lot cost"
        className="field-inline w-32 px-2 py-1 text-sm"
      />
      <button
        type="submit"
        className="field-inline px-2 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
      >
        Save
      </button>
    </form>
  );
}
