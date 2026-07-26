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
        <label className="text-sm text-neutral-700">Name</label>
        <input
          name="name"
          defaultValue={asset.name}
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-300"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm text-neutral-700">Category</label>
        <input
          name="category"
          defaultValue={asset.category}
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-300"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm text-neutral-700">Stock status</label>
        <select
          name="stockStatus"
          defaultValue={asset.stockStatus}
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm"
        >
          {STOCK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {formatLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-sm text-neutral-700">Condition grade</label>
        <select
          name="conditionGrade"
          defaultValue={asset.conditionGrade ?? ''}
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm"
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
        <label className="text-sm text-neutral-700">Location</label>
        <select
          name="locationId"
          defaultValue={asset.locationId ?? ''}
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm"
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
        <label className="text-sm text-neutral-700">Unit cost override (£)</label>
        <input
          type="number"
          min={0}
          step="0.01"
          name="purchaseCost"
          defaultValue={asset.purchaseCost ?? ''}
          placeholder="leave blank to use even split of lot cost"
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-300"
        />
      </div>

      {state.error && <p className="text-sm text-red-600">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#2b7fff] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}
