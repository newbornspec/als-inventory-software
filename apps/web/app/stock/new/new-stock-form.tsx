'use client';

import { useActionState } from 'react';
import { createStockLine } from '@/lib/actions/stock';
import type { ActionState } from '@/lib/actions/assets';
import type { Location } from '@/lib/data';

export function NewStockForm({ locations }: { locations: Location[] }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createStockLine, {
    error: null,
  });

  return (
    <form action={formAction} className="mt-6 max-w-sm space-y-3">
      <div className="space-y-1">
        <label htmlFor="stock-new-new-stock-form-name" className="text-sm text-neutral-700">Item name</label>
        <input id="stock-new-new-stock-form-name" name="name"
          placeholder="USB keyboard"
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="stock-new-new-stock-form-sku" className="text-sm text-neutral-700">SKU</label>
          <input id="stock-new-new-stock-form-sku" name="sku"
            placeholder="KB-USB-01"
            className="field-underline w-full px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="stock-new-new-stock-form-category" className="text-sm text-neutral-700">Category</label>
          <input id="stock-new-new-stock-form-category" name="category"
            placeholder="Peripherals"
            className="field-underline w-full px-3 py-2 text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="stock-new-new-stock-form-quantity" className="text-sm text-neutral-700">Opening quantity</label>
          <input id="stock-new-new-stock-form-quantity" type="number"
            min={0}
            name="quantity"
            placeholder="0"
            className="field-underline w-full px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="stock-new-new-stock-form-locationId" className="text-sm text-neutral-700">Location</label>
          <select id="stock-new-new-stock-form-locationId" name="locationId"
            defaultValue=""
            className="field-underline w-full px-3 py-2 text-sm"
          >
            <option value="">Unassigned</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <label htmlFor="stock-new-new-stock-form-notes" className="text-sm text-neutral-700">Notes</label>
        <textarea id="stock-new-new-stock-form-notes" name="notes"
          rows={2}
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>

      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create item'}
      </button>
    </form>
  );
}
