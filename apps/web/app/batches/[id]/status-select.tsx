'use client';

import { updateBatchStatus } from '@/lib/actions/batches';
import { formatLabel } from '@/lib/asset-options';

const BATCH_STATUSES = ['draft', 'awaiting_arrival', 'open', 'receiving', 'closed', 'reconciled'];

export function BatchStatusSelect({ batchId, status }: { batchId: string; status: string }) {
  const boundUpdate = updateBatchStatus.bind(null, batchId);

  return (
    <form action={boundUpdate}>
      <select
        name="status"
        defaultValue={status}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="w-full bg-transparent text-lg font-semibold"
      >
        {BATCH_STATUSES.map((s) => (
          <option key={s} value={s} className="bg-neutral-900">
            {formatLabel(s)}
          </option>
        ))}
      </select>
    </form>
  );
}
