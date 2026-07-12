'use client';

import { updateOrderStatus } from '@/lib/actions/sales';
import { formatLabel } from '@/lib/asset-options';

const SALES_STATUSES = [
  'draft',
  'reserved',
  'picking',
  'picked',
  'invoiced',
  'shipped',
  'completed',
  'cancelled',
];

export function OrderStatusSelect({ orderId, status }: { orderId: string; status: string }) {
  const boundUpdate = updateOrderStatus.bind(null, orderId);
  return (
    <form action={boundUpdate}>
      <select
        name="status"
        defaultValue={status}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="w-full bg-transparent text-lg font-semibold"
      >
        {SALES_STATUSES.map((s) => (
          <option key={s} value={s} className="bg-neutral-900">
            {formatLabel(s)}
          </option>
        ))}
      </select>
    </form>
  );
}
