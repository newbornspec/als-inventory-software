'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { createLot } from '@/lib/actions/batches';
import type { ActionState } from '@/lib/actions/assets';

// Create a spec bucket for this lot.
//
// Behaviour is unchanged — React 19 already resets a form whose `action` is a
// function, so the fields do clear themselves after a successful create. This is
// a layout change: the form used to sit permanently expanded at the foot of the
// page, a nine-field block always on screen whether or not anyone wanted a new
// bucket. It is a disclosure now, matching its sibling add-asset-form, with an
// explicit line confirming what was made so the acknowledgement does not depend
// on noticing a new card appear further up.
export function NewLotForm({ batchId }: { batchId: string }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState(0);
  const boundCreate = createLot.bind(null, batchId);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(boundCreate, {
    error: null,
  });
  const submitting = useRef(false);

  useEffect(() => {
    if (!pending && submitting.current) {
      submitting.current = false;
      if (!state.error) setCreated((c) => c + 1);
    }
  }, [pending, state]);

  const field = 'field-underline w-full px-2 py-1.5 text-sm';

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="rounded-md border border-[var(--control-border)] px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
      >
        {open ? 'Cancel' : '+ New sub-lot'}
      </button>

      {open && (
        <form
          id={panelId}
          action={formAction}
          onSubmit={() => {
            submitting.current = true;
          }}
          className="mt-3 space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4"
        >
          <h3 className="text-sm font-medium text-neutral-950">New sub-lot (spec bucket)</h3>
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
          </div>
          {state.error && (
            <p role="alert" className="text-xs text-red-700">
              {state.error}
            </p>
          )}
          {created > 0 && !state.error && (
            <p role="status" className="text-xs text-emerald-800">
              Sub-lot created — it is in the list above.
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-[#1a6ef5] px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {pending ? 'Creating…' : 'Create sub-lot'}
          </button>
        </form>
      )}
    </div>
  );
}
