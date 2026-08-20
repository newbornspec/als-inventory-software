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
    <form action={boundUpdate} className="flex flex-wrap items-center gap-2">
      <input
        name="buyer"
        aria-label="Buyer"
        defaultValue={buyer ?? ''}
        placeholder="buyer"
        className="field-inline w-full min-w-0 px-2 py-1 text-sm sm:w-48"
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
