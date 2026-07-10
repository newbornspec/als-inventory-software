'use client';

import { useActionState } from 'react';
import { createLot } from '@/lib/actions/batches';
import type { ActionState } from '@/lib/actions/assets';

export function NewLotForm({ batchId }: { batchId: string }) {
  const boundCreate = createLot.bind(null, batchId);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(boundCreate, {
    error: null,
  });

  return (
    <form action={formAction} className="mt-3 space-y-2 rounded-md border border-neutral-800 p-3">
      <input
        name="description"
        placeholder="Sub-lot spec, e.g. Dell 5050 · i5 · 8GB"
        className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
      />
      <input
        type="number"
        min={0}
        name="expectedUnitCount"
        placeholder="Expected units"
        className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
      />
      {state.error && <p className="text-xs text-red-400">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create sub-lot'}
      </button>
    </form>
  );
}
