'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteAsset } from '@/lib/actions/assets';

// Deleting a device from ITS OWN page asked nothing, while deleting the same
// device from its lot (batches/[id]/lot-assets.tsx) has always confirmed and
// spelled out that the audit history goes with it. Same action, same
// consequence, two different levels of care — this closes that.
//
// It sits beside SellAssetButton, which confirms for a reversible-by-an-admin
// action; deletion is not reversible at all.
export function DeleteAssetButton({
  assetId,
  name,
  tag,
  auditCount,
}: {
  assetId: string;
  name: string;
  tag: string;
  auditCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onDelete() {
    // Name what actually goes. An audit trail is the one thing an ITAD
    // business cannot reconstruct, so it is said out loud when there is one.
    const consequences = [
      `${tag} is removed from the register`,
      auditCount > 0
        ? `its ${auditCount} audit record${auditCount === 1 ? '' : 's'} — including any data-erasure evidence — are destroyed`
        : 'it has no audit records to lose',
      'any photos and history go with it',
    ];
    const message =
      `Delete "${name}"?\n\n` +
      consequences.map((c) => `• ${c}`).join('\n') +
      '\n\nThis cannot be undone.';
    if (!window.confirm(message)) return;

    setError(null);
    startTransition(async () => {
      try {
        await deleteAsset(assetId);
        router.push('/assets');
      } catch {
        setError('Could not delete this device.');
      }
    });
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        aria-label={`Delete ${name}`}
        className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}
