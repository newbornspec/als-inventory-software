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
    <form action={boundUpdate} className="flex flex-wrap items-center gap-2">
      <input
        name="supplier"
        aria-label="Supplier"
        defaultValue={supplier ?? ''}
        placeholder="supplier"
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
