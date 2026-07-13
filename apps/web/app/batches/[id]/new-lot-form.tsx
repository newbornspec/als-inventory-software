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
    'w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm';

  return (
    <form action={formAction} className="mt-3 space-y-2 rounded-md border border-neutral-800 p-3">
      <p className="text-xs font-medium text-neutral-400">New sub-lot (spec bucket)</p>
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
