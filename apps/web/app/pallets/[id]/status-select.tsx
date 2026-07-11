'use client';

import { updatePalletStatus } from '@/lib/actions/pallets';
import { formatLabel } from '@/lib/asset-options';

const PALLET_STATUSES = ['open', 'ready', 'shipped'];

export function PalletStatusSelect({ palletId, status }: { palletId: string; status: string }) {
  const boundUpdate = updatePalletStatus.bind(null, palletId);
  return (
    <form action={boundUpdate}>
      <select
        name="status"
        defaultValue={status}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="w-full bg-transparent text-lg font-semibold"
      >
        {PALLET_STATUSES.map((s) => (
          <option key={s} value={s} className="bg-neutral-900">
            {formatLabel(s)}
          </option>
        ))}
      </select>
    </form>
  );
}
