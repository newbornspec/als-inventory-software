'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { removeAssetsFromPallet, type PalletAssetRow } from '@/lib/actions/pallets';
import { formatLabel } from '@/lib/asset-options';

// The device table on an asset pallet's page. Every row links to the device
// (it never left the register), and Remove sends it back to its lot's pool —
// same permission as the move, full history logged either way.
export function PalletAssets({
  palletId,
  assets,
  canMove,
}: {
  palletId: string;
  assets: PalletAssetRow[];
  canMove: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(assetId: string) {
    setBusy(assetId);
    setError(null);
    const result = await removeAssetsFromPallet([assetId], palletId);
    setBusy(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  if (assets.length === 0) {
    return (
      <p className="mt-6 text-sm text-neutral-500">
        No devices on this pallet yet — move them here from a lot on the Goods In page.
      </p>
    );
  }

  return (
    <div role="region" aria-label="Devices on this pallet" tabIndex={0} className="mt-6 overflow-x-auto rounded-lg border border-neutral-200">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Serialized devices allocated to this pallet</caption>
        <thead className="bg-neutral-50 text-neutral-500">
          <tr>
            <th scope="col" className="px-4 py-2">Device</th>
            <th scope="col" className="px-4 py-2">Unit ID</th>
            <th scope="col" className="px-4 py-2">Grade</th>
            <th scope="col" className="px-4 py-2">Audit status</th>
            <th scope="col" className="px-4 py-2">Moved</th>
            <th scope="col" className="px-4 py-2">By</th>
            {canMove && <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => (
            <tr key={a.id} className="border-t border-neutral-200">
              <td className="px-4 py-2">
                <Link href={`/assets/${a.id}`} className="font-medium text-[#1a6ef5] hover:underline">
                  {a.name}
                </Link>
              </td>
              <td className="px-4 py-2 font-mono text-xs text-neutral-600">{a.unitId ?? a.tag}</td>
              <td className="px-4 py-2 text-neutral-600">
                {a.conditionGrade ? formatLabel(a.conditionGrade) : '—'}
              </td>
              <td className="px-4 py-2 text-neutral-600">
                {a.auditStatus ? formatLabel(a.auditStatus) : '—'}
              </td>
              <td className="px-4 py-2 whitespace-nowrap text-neutral-600">
                {a.movedToPalletAt ? new Date(a.movedToPalletAt).toLocaleString('en-GB') : '—'}
              </td>
              <td className="px-4 py-2 text-neutral-600">{a.movedToPalletByName ?? '—'}</td>
              {canMove && (
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => remove(a.id)}
                    disabled={busy === a.id}
                    aria-label={`Remove ${a.name} from this pallet`}
                    className="text-xs text-neutral-700 underline hover:text-neutral-950 disabled:opacity-50"
                  >
                    {busy === a.id ? 'Removing…' : 'Remove'}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {error && (
        <p role="alert" className="border-t border-neutral-200 px-4 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
