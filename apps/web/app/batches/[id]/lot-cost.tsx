'use client';

import { updateBatchCost } from '@/lib/actions/batches';

export function LotCost({ batchId, totalCost }: { batchId: string; totalCost: number | null }) {
  const boundUpdate = updateBatchCost.bind(null, batchId);
  return (
    <form action={boundUpdate} className="flex items-center gap-2">
      <span className="text-neutral-500">£</span>
      <input
        name="totalCost"
        type="number"
        min={0}
        step="0.01"
        defaultValue={totalCost ?? ''}
        placeholder="lot cost"
        className="w-32 rounded border border-neutral-200 bg-white px-2 py-1 text-sm"
      />
      <button
        type="submit"
        className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-950"
      >
        Save
      </button>
    </form>
  );
}
