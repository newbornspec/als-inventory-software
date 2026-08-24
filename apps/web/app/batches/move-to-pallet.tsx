'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { moveAssetsToPallet } from '@/lib/actions/pallets';

interface PalletOption {
  id: string;
  palletNumber: string;
  entryLayout?: string;
  status: string;
  totalQuantity: number;
}

// The action bar that appears once devices are ticked in a lot: pick an asset
// pallet (or a new one) and move the selection onto it. Devices leave this
// lot's pool but stay in the register — the move is reversible from the
// pallet's page.
//
// The success outcome is handed UP rather than rendered here. Both callers show
// this bar only while something is selected, and both clear the selection in
// onMoved — so writing "Moved 17 devices — 5 skipped (already on a pallet)" into
// this component's own state tore it down in the same commit and the operator
// never saw it. The skipped list is not cosmetic: the API refuses devices that
// are sold, already on another pallet, or in a lot a scoped manager does not
// own, and it reports one reason per device.
export function MoveToPallet({
  selectedIds,
  onMoved,
}: {
  selectedIds: string[];
  onMoved: (outcome: string) => void;
}) {
  const router = useRouter();
  const [pallets, setPallets] = useState<PalletOption[] | null>(null);
  const [target, setTarget] = useState<string>('new');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // Only asset pallets still in the warehouse can receive devices — the API
    // refuses quantity pallets and shipped/merged ones, so don't offer them.
    fetch('/api/pallets')
      .then((res) => (res.ok ? res.json() : []))
      .then((all: PalletOption[]) =>
        setPallets(
          all.filter(
            (p) => p.entryLayout === 'asset' && p.status !== 'shipped' && p.status !== 'merged',
          ),
        ),
      )
      .catch(() => setPallets([]));
  }, []);

  async function handleMove() {
    setBusy(true);
    setMessage(null);
    const result = await moveAssetsToPallet(
      target === 'new' ? { createNew: true } : { palletId: target },
      selectedIds,
    );
    setBusy(false);
    if (result.error) {
      setMessage(result.error);
      return;
    }
    const skipped = result.skipped?.length ?? 0;
    const outcome =
      `Moved ${result.moved} device${result.moved === 1 ? '' : 's'} to ${result.palletNumber}` +
      (skipped
        ? ` — ${skipped} skipped (${result.skipped!.map((s) => s.reason).join('; ')})`
        : '');
    // Errors stay here: a failure does not clear the selection, so this bar is
    // still mounted to show them.
    onMoved(outcome);
    router.refresh();
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
      <span className="text-sm font-medium text-neutral-900">
        {selectedIds.length} selected
      </span>
      <label htmlFor="move-target" className="text-sm text-neutral-700">
        Move to
      </label>
      <select
        id="move-target"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="field-inline px-2 py-1 text-sm"
      >
        <option value="new">New pallet…</option>
        {(pallets ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.palletNumber} ({p.totalQuantity} device{p.totalQuantity === 1 ? '' : 's'})
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={handleMove}
        disabled={busy || selectedIds.length === 0}
        className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Moving…' : 'Move to pallet'}
      </button>
      {message && (
        <span role="status" className="text-sm text-neutral-700">
          {message}
        </span>
      )}
    </div>
  );
}
