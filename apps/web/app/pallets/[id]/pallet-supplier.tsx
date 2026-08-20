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
        className="w-full min-w-0 rounded sm:w-48 border border-[var(--field-border)] bg-white px-2 py-1 text-sm"
      />
      <button
        type="submit"
        className="rounded border border-[var(--field-border)] px-2 py-1 text-xs text-neutral-950"
      >
        Save
      </button>
    </form>
  );
}
