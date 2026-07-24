'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sellWholePallet } from '@/lib/actions/sold';

// Sell everything remaining on the pallet in one click. The quantities move to
// the Sold page and the pallet is stamped shipped.
export function SellPalletButton({
  palletId,
  palletNumber,
  totalQuantity,
}: {
  palletId: string;
  palletNumber: string;
  totalQuantity: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sell() {
    if (
      !confirm(
        `Sell the whole of ${palletNumber} (${totalQuantity} units)? Everything moves to the Sold page and only an admin can return it.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    const res = await sellWholePallet(palletId);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  if (totalQuantity <= 0) return null;

  return (
    <span className="flex items-center gap-2">
      <button
        onClick={sell}
        disabled={busy}
        className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
      >
        {busy ? 'Selling…' : 'Sell whole pallet'}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
