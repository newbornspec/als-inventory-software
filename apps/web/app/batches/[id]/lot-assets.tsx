'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Asset } from '@/lib/actions/assets';
import type { Lot } from '@/lib/actions/batches';
import { assignSubLot } from '@/lib/actions/batches';

// The devices audited into this purchase lot. Managers can drop each one into a
// sub-lot (spec bucket) via the dropdown — that's what makes the sub-lot counts,
// progress and roll-up real.
export function LotAssets({
  assets,
  subLots,
  batchId,
  canManage,
}: {
  assets: Asset[];
  subLots: Lot[];
  batchId: string;
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onAssign(assetId: string, value: string) {
    startTransition(async () => {
      await assignSubLot(assetId, value || null, batchId);
      router.refresh();
    });
  }

  if (assets.length === 0) {
    return (
      <p className="mt-3 text-sm text-neutral-500">
        No assets scanned into this lot yet — audit devices into it, or use Receiving mode on the
        Scan page.
      </p>
    );
  }

  return (
    <ul className={'mt-3 space-y-1 ' + (pending ? 'opacity-60' : '')}>
      {assets.map((a) => (
        <li key={a.id} className="flex items-center justify-between gap-3 py-0.5">
          <Link href={`/assets/${a.id}`} className="truncate text-sm text-neutral-200 underline">
            {a.name}
          </Link>
          {canManage && subLots.length > 0 && (
            <select
              value={a.lotId ?? ''}
              onChange={(e) => onAssign(a.id, e.target.value)}
              disabled={pending}
              className="shrink-0 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
              aria-label={`Sub-lot for ${a.name}`}
            >
              <option value="">— No sub-lot —</option>
              {subLots.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.lotNumber}
                  {l.description ? ` · ${l.description}` : ''}
                </option>
              ))}
            </select>
          )}
        </li>
      ))}
    </ul>
  );
}
