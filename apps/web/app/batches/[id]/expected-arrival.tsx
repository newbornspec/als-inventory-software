'use client';

import { useActionState, useId } from 'react';
import { updateBatchExpectedArrival } from '@/lib/actions/batches';
import type { ActionState } from '@/lib/actions/assets';

// The date the goods are due. Editable here as well as on the create form,
// because a delivery date is usually agreed after the lot has been raised —
// and the dashboard's incoming/overdue counts are only as good as this field.
// Which is exactly why a silent failure mattered: the button stayed live during
// the request, nothing reported a rejection, and the field kept showing the
// typed date, so a lot could sit misreported on the dashboard indefinitely.
export function ExpectedArrival({
  batchId,
  expectedArrivalDate,
}: {
  batchId: string;
  expectedArrivalDate: string | null;
}) {
  const id = useId();
  const bound = updateBatchExpectedArrival.bind(null, batchId);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(bound, {
    error: null,
  });

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="sr-only">
        Expected arrival date — leave blank if no delivery date is promised
      </label>
      <input
        id={id}
        name="expectedArrivalDate"
        type="date"
        defaultValue={expectedArrivalDate ?? ''}
        disabled={pending}
        className="field-inline px-2 py-1 text-sm disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={pending}
        className="field-inline px-2 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
      {state.error && (
        <span role="alert" className="text-xs text-red-700">
          {state.error}
        </span>
      )}
    </form>
  );
}
