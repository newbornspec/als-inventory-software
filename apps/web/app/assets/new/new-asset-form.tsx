'use client';

import { useActionState } from 'react';
import { createAsset, type ActionState } from '@/lib/actions/assets';
import type { Location } from '@/lib/data';
import { CONDITION_GRADES, STOCK_STATUSES, formatLabel } from '@/lib/asset-options';

export function NewAssetForm({ locations }: { locations: Location[] }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createAsset, {
    error: null,
  });

  return (
    <form action={formAction} className="mt-6 max-w-sm space-y-3">
      <div className="space-y-1">
        <label htmlFor="assets-new-new-asset-form-tag" className="text-sm text-neutral-700">Tag (barcode/QR value)</label>
        <input id="assets-new-new-asset-form-tag" name="tag"
          required
          placeholder="AST-0006"
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm focus:border-neutral-300"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="assets-new-new-asset-form-name" className="text-sm text-neutral-700">Name</label>
        <input id="assets-new-new-asset-form-name" name="name"
          required
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm focus:border-neutral-300"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="assets-new-new-asset-form-category" className="text-sm text-neutral-700">Category</label>
        <input id="assets-new-new-asset-form-category" name="category"
          required
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm focus:border-neutral-300"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="assets-new-new-asset-form-stockStatus" className="text-sm text-neutral-700">Stock status</label>
        <select id="assets-new-new-asset-form-stockStatus" name="stockStatus"
          defaultValue="received"
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
        <label htmlFor="assets-new-new-asset-form-conditionGrade" className="text-sm text-neutral-700">Condition grade (optional)</label>
        <select id="assets-new-new-asset-form-conditionGrade" name="conditionGrade"
          defaultValue=""
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
        <label htmlFor="assets-new-new-asset-form-locationId" className="text-sm text-neutral-700">Location</label>
        <select id="assets-new-new-asset-form-locationId" name="locationId"
          defaultValue=""
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
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create asset'}
      </button>
    </form>
  );
}
