'use client';

import { useActionState } from 'react';
import { createBatch } from '@/lib/actions/batches';
import type { ActionState } from '@/lib/actions/assets';
import type { Location } from '@/lib/data';

export function NewBatchForm({ locations }: { locations: Location[] }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createBatch, {
    error: null,
  });

  return (
    <form action={formAction} className="mt-6 max-w-sm space-y-3">
      <div className="space-y-1">
        <label className="text-sm text-neutral-300">Supplier</label>
        <input
          name="source"
          placeholder="Acme Corp decommission"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-sm text-neutral-300">Purchase order</label>
          <input
            name="purchaseOrder"
            placeholder="PO-10025"
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm text-neutral-300">Delivery note</label>
          <input
            name="deliveryNote"
            placeholder="DN-4471"
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-sm text-neutral-300">Purchase date</label>
          <input
            type="date"
            name="purchaseDate"
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm text-neutral-300">Expected unit count</label>
          <input
            type="number"
            min={0}
            name="expectedUnitCount"
            placeholder="50"
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-sm text-neutral-300">Location</label>
        <select
          name="locationId"
          defaultValue=""
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        >
          <option value="">Unassigned</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-sm text-neutral-300">Notes</label>
        <textarea
          name="notes"
          rows={2}
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
      </div>

      {state.error && <p className="text-sm text-red-400">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create purchase lot'}
      </button>
    </form>
  );
}
