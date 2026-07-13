'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { addManualAsset, type ActionState } from '@/lib/actions/assets';

// Manually add a device into this lot. Collapsed to a button until needed; the
// form resets on a successful save so several can be entered in a row.
export function AddAssetForm({ batchId }: { batchId: string }) {
  const [open, setOpen] = useState(false);
  const bound = addManualAsset.bind(null, batchId);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(bound, { error: null });
  const formRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);

  useEffect(() => {
    if (!pending && submitting.current) {
      submitting.current = false;
      if (!state.error) formRef.current?.reset();
    }
  }, [pending, state]);

  const field = 'w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm';

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900"
      >
        + Add asset
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={() => {
        submitting.current = true;
      }}
      className="mt-3 space-y-2 rounded-md border border-neutral-800 p-3"
    >
      <p className="text-xs font-medium text-neutral-400">Add asset manually</p>
      <div className="grid grid-cols-2 gap-2">
        <input name="manufacturer" placeholder="Manufacturer, e.g. Dell" className={field} />
        <input name="model" placeholder="Model, e.g. Latitude 5420" className={field} />
        <input name="deviceType" placeholder="Device type, e.g. Laptop" className={field} />
        <input name="serialNumber" placeholder="Serial number" className={field} />
        <input name="cpu" placeholder="CPU, e.g. i5-1145G7" className={field} />
        <input type="number" min={0} name="ramGb" placeholder="RAM (GB)" className={field} />
        <input name="storage" placeholder="Storage, e.g. 256GB SSD" className={field} />
        <input name="screenSize" placeholder='Screen, e.g. 14"' className={field} />
        <input name="batteryHealth" placeholder="Battery, e.g. 92%" className={field} />
      </div>
      <input name="notes" placeholder="Notes (optional)" className={field} />
      {state.error && <p className="text-xs text-red-400">{state.error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-50"
        >
          {pending ? 'Adding…' : 'Save asset'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
