'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { addManualAsset, type ActionState } from '@/lib/actions/assets';
import type { Lot } from '@/lib/actions/batches';

// Manually add a device into this lot. Collapsed to a button until needed. On a
// successful save the text fields clear (keyed remount) but the chosen sub-lot
// stays selected, so a run of same-config devices can be entered into one bucket.
export function AddAssetForm({ batchId, subLots }: { batchId: string; subLots: Lot[] }) {
  const [open, setOpen] = useState(false);
  const [subLotId, setSubLotId] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const bound = addManualAsset.bind(null, batchId);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(bound, { error: null });
  const submitting = useRef(false);

  useEffect(() => {
    if (!pending && submitting.current) {
      submitting.current = false;
      if (!state.error) setResetKey((k) => k + 1); // clear text inputs, keep the sub-lot
    }
  }, [pending, state]);

  const field = 'field-underline w-full px-2 py-1.5 text-sm';
  const specOf = (l: Lot) =>
    [l.manufacturer, l.model, l.cpu, l.ramGb ? `${l.ramGb}GB` : null, l.storage]
      .filter(Boolean)
      .join(' · ') || l.description;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className="mt-3 rounded-md border border-[var(--control-border)] px-3 py-1.5 text-xs text-neutral-700 hover:bg-white"
      >
        + Add asset
      </button>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={() => {
        submitting.current = true;
      }}
      className="mt-3 space-y-2 rounded-md border border-neutral-200 p-3"
    >
      <h3 className="text-xs font-medium text-neutral-700">Add asset manually</h3>

      {subLots.length > 0 && (
        <select
          name="subLotId"
          value={subLotId}
          onChange={(e) => setSubLotId(e.target.value)}
          className={field}
          aria-label="Sub-lot"
        >
          <option value="">— No sub-lot —</option>
          {subLots.map((l) => (
            <option key={l.id} value={l.id}>
              {l.lotNumber}
              {specOf(l) ? ` · ${specOf(l)}` : ''}
            </option>
          ))}
        </select>
      )}

      <div key={resetKey} className="space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input name="manufacturer" aria-label="Manufacturer" placeholder="Manufacturer, e.g. Dell" className={field} />
          <input name="model" aria-label="Model" placeholder="Model, e.g. Latitude 5420" className={field} />
          <input name="deviceType" aria-label="Device type" placeholder="Device type, e.g. Laptop" className={field} />
          <input name="serialNumber" aria-label="Serial number" placeholder="Serial number" className={field} />
          <input name="cpu" aria-label="CPU" placeholder="CPU, e.g. i5-1145G7" className={field} />
          <input type="number" min={0} name="ramGb" aria-label="RAM in GB" placeholder="RAM (GB)" className={field} />
          <input name="storage" aria-label="Storage" placeholder="Storage, e.g. 256GB SSD" className={field} />
          <input name="screenSize" aria-label="Screen size" placeholder='Screen, e.g. 14"' className={field} />
          <input name="batteryHealth" aria-label="Battery health" placeholder="Battery, e.g. 92%" className={field} />
        </div>
        <input name="notes" aria-label="Notes" placeholder="Notes (optional)" className={field} />
      </div>

      {state.error && <p role="alert" className="text-xs text-red-700">{state.error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Adding…' : 'Save asset'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-[var(--control-border)] px-3 py-1.5 text-xs text-neutral-500"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
