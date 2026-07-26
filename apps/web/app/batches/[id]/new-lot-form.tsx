'use client';

import { useActionState } from 'react';
import { createLot } from '@/lib/actions/batches';
import type { ActionState } from '@/lib/actions/assets';

export function NewLotForm({ batchId }: { batchId: string }) {
  const boundCreate = createLot.bind(null, batchId);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(boundCreate, {
    error: null,
  });

  const field =
    'w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm';

  return (
    <form action={formAction} className="mt-3 space-y-2 rounded-md border border-neutral-200 p-3">
      <p className="text-xs font-medium text-neutral-500">New sub-lot (spec bucket)</p>
      <div className="grid grid-cols-2 gap-2">
        <input name="manufacturer" placeholder="Manufacturer, e.g. Dell" className={field} />
        <input name="model" placeholder="Model, e.g. OptiPlex 5050" className={field} />
        <input name="cpu" placeholder="CPU, e.g. i5-7500" className={field} />
        <input type="number" min={0} name="ramGb" placeholder="RAM (GB)" className={field} />
        <input name="storage" placeholder="Storage, e.g. 256GB SSD" className={field} />
        <input name="screenSize" placeholder='Screen, e.g. 14"' className={field} />
      </div>
      <input
        name="description"
        placeholder="Label / notes (optional)"
        className={field}
      />
      <input
        type="number"
        min={0}
        name="expectedUnitCount"
        placeholder="Expected units"
        className={field}
      />
      {state.error && <p className="text-xs text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#2b7fff] hover:bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create sub-lot'}
      </button>
    </form>
  );
}
