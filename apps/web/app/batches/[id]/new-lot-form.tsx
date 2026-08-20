'use client';

import { useActionState } from 'react';
import { createLot } from '@/lib/actions/batches';
import type { ActionState } from '@/lib/actions/assets';

export function NewLotForm({ batchId }: { batchId: string }) {
  const boundCreate = createLot.bind(null, batchId);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(boundCreate, {
    error: null,
  });

  const field = 'field-underline w-full px-2 py-1.5 text-sm';

  return (
    <form action={formAction} className="mt-3 space-y-2 rounded-md border border-neutral-200 p-3">
      <h3 className="text-xs font-medium text-neutral-700">New sub-lot (spec bucket)</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input name="manufacturer" aria-label="Manufacturer" placeholder="Manufacturer, e.g. Dell" className={field} />
        <input name="model" aria-label="Model" placeholder="Model, e.g. OptiPlex 5050" className={field} />
        <input name="cpu" aria-label="CPU" placeholder="CPU, e.g. i5-7500" className={field} />
        <input type="number" min={0} name="ramGb" aria-label="RAM in GB" placeholder="RAM (GB)" className={field} />
        <input name="storage" aria-label="Storage" placeholder="Storage, e.g. 256GB SSD" className={field} />
        <input name="screenSize" aria-label="Screen size" placeholder='Screen, e.g. 14"' className={field} />
      </div>
      <input
        name="description"
        aria-label="Label or notes"
        placeholder="Label / notes (optional)"
        className={field}
      />
      <input
        type="number"
        min={0}
        name="expectedUnitCount"
        aria-label="Expected units"
        placeholder="Expected units"
        className={field}
      />
      {state.error && <p role="alert" className="text-xs text-red-700">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create sub-lot'}
      </button>
    </form>
  );
}
