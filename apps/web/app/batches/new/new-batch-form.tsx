'use client';

import { useActionState } from 'react';
import { createBatch } from '@/lib/actions/batches';
import type { ActionState } from '@/lib/actions/assets';
import type { Location } from '@/lib/data';

// Every label is tied to its control with htmlFor/id. They used to be bare
// <label> elements sitting next to an input, which reads as an unlabelled text
// field to a screen reader and gives no click target.
const FIELD =
  'w-full rounded-md border border-[var(--field-border)] bg-white px-3 py-2 text-sm focus:border-[var(--field-border)]';
const LABEL = 'block text-sm text-neutral-700';

export function NewBatchForm({ locations }: { locations: Location[] }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createBatch, {
    error: null,
  });

  return (
    <form action={formAction} className="mt-6 max-w-sm space-y-3">
      <div className="space-y-1">
        <label htmlFor="batch-source" className={LABEL}>
          Supplier
        </label>
        <input
          id="batch-source"
          name="source"
          placeholder="Acme Corp decommission"
          className={FIELD}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="batch-po" className={LABEL}>
            Purchase order
          </label>
          <input id="batch-po" name="purchaseOrder" placeholder="PO-10025" className={FIELD} />
        </div>
        <div className="space-y-1">
          <label htmlFor="batch-dn" className={LABEL}>
            Delivery note
          </label>
          <input id="batch-dn" name="deliveryNote" placeholder="DN-4471" className={FIELD} />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="batch-purchase-date" className={LABEL}>
            Purchase date
          </label>
          <input id="batch-purchase-date" type="date" name="purchaseDate" className={FIELD} />
        </div>
        <div className="space-y-1">
          <label htmlFor="batch-expected-arrival" className={LABEL}>
            Expected arrival
          </label>
          <input
            id="batch-expected-arrival"
            type="date"
            name="expectedArrivalDate"
            aria-describedby="batch-expected-arrival-hint"
            className={FIELD}
          />
          <p id="batch-expected-arrival-hint" className="text-xs text-neutral-600">
            When delivery is due. Drives the dashboard&rsquo;s incoming and overdue counts — leave
            blank if no date was promised.
          </p>
        </div>
      </div>
      <div className="space-y-1">
        <label htmlFor="batch-expected-units" className={LABEL}>
          Expected unit count
        </label>
        <input
          id="batch-expected-units"
          type="number"
          min={0}
          name="expectedUnitCount"
          placeholder="50"
          className={FIELD}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="batch-location" className={LABEL}>
          Location
        </label>
        <select id="batch-location" name="locationId" defaultValue="" className={FIELD}>
          <option value="">Unassigned</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="batch-notes" className={LABEL}>
          Notes
        </label>
        <textarea id="batch-notes" name="notes" rows={2} className={FIELD} />
      </div>

      {/* role=alert so the failure is announced, not just painted red. */}
      {state.error && (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create purchase lot'}
      </button>
    </form>
  );
}
