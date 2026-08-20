'use client';

import { useActionState } from 'react';
import { createPallet } from '@/lib/actions/pallets';
import type { ActionState } from '@/lib/actions/assets';
import type { Location } from '@/lib/data';

export function NewPalletForm({
  locations,
  suggestedNumber = '',
}: {
  locations: Location[];
  suggestedNumber?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createPallet, {
    error: null,
  });

  return (
    <form action={formAction} className="mt-6 max-w-sm space-y-3">
      {/* The number is written on the physical pallet before anyone reaches a
          keyboard, so it is typed rather than generated. Prefilled with the next
          one in sequence; clearing it falls back to that same sequence. */}
      <div className="space-y-1">
        <label htmlFor="pallets-new-new-pallet-form-palletNumber" className="text-sm text-neutral-700">Pallet number</label>
        <input id="pallets-new-new-pallet-form-palletNumber" name="palletNumber"
          defaultValue={suggestedNumber}
          placeholder="e.g. PALLET-000045"
          className="field-underline w-full px-3 py-2 text-sm"
        />
        <p className="text-xs text-neutral-500">
          Use the number on the pallet. Leave blank to number it automatically.
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor="pallets-new-new-pallet-form-description" className="text-sm text-neutral-700">Description</label>
        <input id="pallets-new-new-pallet-form-description" name="description"
          placeholder="e.g. Mixed Dell monitors"
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="pallets-new-new-pallet-form-supplier" className="text-sm text-neutral-700">Supplier</label>
        <input id="pallets-new-new-pallet-form-supplier" name="supplier"
          placeholder="e.g. XYZ Recycling"
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="pallets-new-new-pallet-form-buyer" className="text-sm text-neutral-700">Buyer</label>
        <input id="pallets-new-new-pallet-form-buyer" name="buyer"
          placeholder="e.g. ABC Traders"
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="pallets-new-new-pallet-form-locationId" className="text-sm text-neutral-700">Location</label>
        <select id="pallets-new-new-pallet-form-locationId" name="locationId"
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
      <div className="space-y-1">
        <label htmlFor="pallets-new-new-pallet-form-notes" className="text-sm text-neutral-700">Notes</label>
        <textarea id="pallets-new-new-pallet-form-notes" name="notes"
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
        {pending ? 'Creating…' : 'Create pallet'}
      </button>
    </form>
  );
}
