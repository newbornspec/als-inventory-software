'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sellAsset } from '@/lib/actions/sold';

// Mark as Sold: terminal — the asset leaves active inventory, moves to the
// Sold page and locks (admin-only return). Hence the explicit confirm.
export function SellAssetButton({ assetId, name }: { assetId: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sell() {
    if (!confirm(`Mark "${name}" as Sold? It will leave active inventory and lock — only an admin can return it.`)) return;
    const raw = window.prompt('Sale price £ (optional — leave blank to skip)', '');
    const salePrice = raw && !isNaN(parseFloat(raw)) ? Math.max(0, parseFloat(raw)) : undefined;
    setBusy(true);
    setError(null);
    const res = await sellAsset(assetId, salePrice);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <span className="flex items-center gap-2">
      <button
        onClick={sell}
        disabled={busy}
        className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {busy ? 'Selling…' : 'Mark as Sold'}
      </button>
      {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
