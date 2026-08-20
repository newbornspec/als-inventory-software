'use client';

import { useActionState } from 'react';
import { updateAsset, type ActionState, type Asset } from '@/lib/actions/assets';
import type { Location } from '@/lib/data';
import { CONDITION_GRADES, STOCK_STATUSES, formatLabel } from '@/lib/asset-options';

export function AssetEditForm({ asset, locations }: { asset: Asset; locations: Location[] }) {
  const boundUpdate = updateAsset.bind(null, asset.id);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(boundUpdate, {
    error: null,
  });

  return (
    <form action={formAction} className="mt-4 max-w-sm space-y-3">
      <div className="space-y-1">
        <label htmlFor="assets-id-edit-form-name" className="text-sm text-neutral-700">Name</label>
        <input id="assets-id-edit-form-name" name="name"
          defaultValue={asset.name}
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="assets-id-edit-form-category" className="text-sm text-neutral-700">Category</label>
        <input id="assets-id-edit-form-category" name="category"
          defaultValue={asset.category}
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="assets-id-edit-form-stockStatus" className="text-sm text-neutral-700">Stock status</label>
        <select id="assets-id-edit-form-stockStatus" name="stockStatus"
          defaultValue={asset.stockStatus}
          className="field-underline w-full px-3 py-2 text-sm"
        >
          {STOCK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {formatLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="assets-id-edit-form-conditionGrade" className="text-sm text-neutral-700">Condition grade</label>
        <select id="assets-id-edit-form-conditionGrade" name="conditionGrade"
          defaultValue={asset.conditionGrade ?? ''}
          className="field-underline w-full px-3 py-2 text-sm"
        >
          <option value="">Ungraded</option>
          {CONDITION_GRADES.map((g) => (
            <option key={g} value={g}>
              {formatLabel(g)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="assets-id-edit-form-locationId" className="text-sm text-neutral-700">Location</label>
        <select id="assets-id-edit-form-locationId" name="locationId"
          defaultValue={asset.locationId ?? ''}
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
        <label htmlFor="assets-id-edit-form-purchaseCost" className="text-sm text-neutral-700">Unit cost override (£)</label>
        <input id="assets-id-edit-form-purchaseCost" type="number"
          min={0}
          step="0.01"
          name="purchaseCost"
          defaultValue={asset.purchaseCost ?? ''}
          placeholder="leave blank to use even split of lot cost"
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>

      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}
