'use client';

import { updatePalletSupplier } from '@/lib/actions/pallets';

export function PalletSupplier({
  palletId,
  supplier,
}: {
  palletId: string;
  supplier: string | null;
}) {
  const boundUpdate = updatePalletSupplier.bind(null, palletId);
  return (
    <form action={boundUpdate} className="flex items-center gap-2">
      <input
        name="supplier"
        defaultValue={supplier ?? ''}
        placeholder="supplier"
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
