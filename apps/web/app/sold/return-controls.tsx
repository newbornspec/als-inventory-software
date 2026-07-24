'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { returnSoldAsset, returnSoldPalletLine } from '@/lib/actions/sold';

// Admin-only "Return to Inventory": pick a destination (or keep the original),
// confirm, and the item goes back into active stock.
export function ReturnControl({
  kind,
  id,
  label,
  originalId,
  originalLabel,
  destinations,
}: {
  kind: 'asset' | 'pallet-line';
  id: string;
  label: string; // what's being returned, for the confirm message
  originalId: string | null;
  originalLabel: string | null;
  destinations: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [dest, setDest] = useState(originalId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doReturn() {
    if (!dest) {
      setError('Pick a destination first.');
      return;
    }
    const destLabel = destinations.find((d) => d.id === dest)?.label ?? 'inventory';
    if (!confirm(`Return ${label} to ${destLabel}?`)) return;
    setBusy(true);
    setError(null);
    const res =
      kind === 'asset' ? await returnSoldAsset(id, dest) : await returnSoldPalletLine(id, dest);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={dest}
        onChange={(e) => setDest(e.target.value)}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
      >
        <option value="">— destination —</option>
        {destinations.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
            {d.id === originalId ? ' (original)' : ''}
          </option>
        ))}
      </select>
      <button
        onClick={doReturn}
        disabled={busy}
        className="shrink-0 rounded-md border border-neutral-600 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? 'Returning…' : 'Return to Inventory'}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
      {originalLabel === null && (
        <span className="text-xs text-neutral-600">original location gone</span>
      )}
    </div>
  );
}
