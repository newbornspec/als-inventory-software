'use client';

import { updatePalletBuyer } from '@/lib/actions/pallets';

export function PalletBuyer({
  palletId,
  buyer,
}: {
  palletId: string;
  buyer: string | null;
}) {
  const boundUpdate = updatePalletBuyer.bind(null, palletId);
  return (
    <form action={boundUpdate} className="flex items-center gap-2">
      <input
        name="buyer"
        defaultValue={buyer ?? ''}
        placeholder="buyer"
        className="w-48 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
      />
      <button
        type="submit"
        className="rounded border border-neutral-600 px-2 py-1 text-xs text-neutral-100"
      >
        Save
      </button>
    </form>
  );
}
