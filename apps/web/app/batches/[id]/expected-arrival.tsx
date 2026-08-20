'use client';

import { useId } from 'react';
import { updateBatchExpectedArrival } from '@/lib/actions/batches';

// The date the goods are due. Editable here as well as on the create form,
// because a delivery date is usually agreed after the lot has been raised —
// and the dashboard's incoming/overdue counts are only as good as this field.
export function ExpectedArrival({
  batchId,
  expectedArrivalDate,
}: {
  batchId: string;
  expectedArrivalDate: string | null;
}) {
  const id = useId();
  const boundUpdate = updateBatchExpectedArrival.bind(null, batchId);
  return (
    <form action={boundUpdate} className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        Expected arrival date
      </label>
      <input
        id={id}
        name="expectedArrivalDate"
        type="date"
        defaultValue={expectedArrivalDate ?? ''}
        className="field-inline px-2 py-1 text-sm"
      />
      <button
        type="submit"
        className="field-inline px-2 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
      >
        Save
      </button>
    </form>
  );
}
