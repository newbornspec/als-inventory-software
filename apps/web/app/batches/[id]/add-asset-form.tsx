'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { addManualAsset, type ActionState } from '@/lib/actions/assets';
import type { Lot } from '@/lib/actions/batches';

// Manually add a device into this lot. Collapsed to a button until needed. On a
// successful save the text fields clear (keyed remount) but the chosen sub-lot
// stays selected, so a run of same-config devices can be entered into one bucket.
export function AddAssetForm({ batchId, subLots }: { batchId: string; subLots: Lot[] }) {
  const panelId = useId();
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

  // The trigger stays mounted whether the form is open or not. It used to live
  // inside an `if (!open) return …` branch, which meant three things at once:
  // aria-expanded was read where `open` was always false so it announced
  // "collapsed" forever, opening destroyed the focused element and dropped
  // keyboard focus to <body>, and closing did the same in reverse.
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="rounded-md border border-[var(--control-border)] px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
      >
        {open ? 'Cancel' : '+ Add a device by hand'}
      </button>

      {!open ? null : (
        <form
          id={panelId}
          action={formAction}
          onSubmit={() => {
            submitting.current = true;
          }}
          className="mt-3 space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4"
        >
          <h3 className="text-sm font-medium text-neutral-950">Add a device by hand</h3>

          {subLots.length > 0 && (
            <select
              name="subLotId"
              value={subLotId}
              onChange={(e) => setSubLotId(e.target.value)}
              className={field}
              aria-label="Sub-lot to add this device to"
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
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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

          {state.error && (
            <p role="alert" className="text-xs text-red-700">
              {state.error}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-[#1a6ef5] px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {pending ? 'Adding…' : 'Save device'}
          </button>
        </form>
      )}
    </div>
  );
}
