'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { removeAssetsFromPallet, type PalletAssetRow } from '@/lib/actions/pallets';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';

// The device table on an asset pallet's page. Every row links to the device
// (it never left the register). Remove is ADMIN-GRADE per the client's
// correction — the pallet owns its devices; a reason is asked for and lands
// on the device's history line.
export function PalletAssets({
  palletId,
  assets,
  canReturn,
}: {
  palletId: string;
  assets: PalletAssetRow[];
  canReturn: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(assetId: string, name: string) {
    // prompt doubles as the confirmation: Cancel aborts, empty is allowed
    // (the reason is preferred, not mandatory).
    const reason = window.prompt(
      `Return ${name} to its Goods In lot?\n\nReason (optional):`,
      '',
    );
    if (reason === null) return;
    setBusy(assetId);
    setError(null);
    const result = await removeAssetsFromPallet([assetId], palletId, reason || undefined);
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
            <th scope="col" className="px-4 py-2">Serial</th>
            <th scope="col" className="px-4 py-2">CPU</th>
            <th scope="col" className="px-4 py-2">RAM</th>
            <th scope="col" className="px-4 py-2">Storage</th>
            <th scope="col" className="px-4 py-2">Grade</th>
            <th scope="col" className="px-4 py-2">Audit status</th>
            <th scope="col" className="px-4 py-2">Moved</th>
            <th scope="col" className="px-4 py-2">By</th>
            {canReturn && <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => (
            <tr key={a.id} className="border-t border-neutral-200">
              <td className="px-4 py-2">
                <Link href={`/assets/${a.id}`} className="font-medium text-[#1a6ef5] hover:underline">
                  {a.name}
                </Link>
                {a.deviceType && (
                  <span className="block text-xs text-neutral-500">{a.deviceType}</span>
                )}
              </td>
              <td className="px-4 py-2 font-mono text-xs text-neutral-600">{a.unitId ?? a.tag}</td>
              <td className="px-4 py-2 font-mono text-xs text-neutral-600">{a.serialNumber ?? '—'}</td>
              <td className="px-4 py-2 text-neutral-700">{a.cpu ?? '—'}</td>
              <td className="px-4 py-2 whitespace-nowrap text-neutral-700">
                {a.ramGb != null ? `${a.ramGb}GB` : '—'}
              </td>
              <td className="px-4 py-2 text-neutral-700">{a.storage ?? '—'}</td>
              <td className="px-4 py-2 text-neutral-600">
                {a.conditionGrade ? formatLabel(a.conditionGrade) : '—'}
              </td>
              <td className="px-4 py-2 text-neutral-600">
                {a.soldAt ? (
                  <span className="inline-block rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">
                    Sold{a.salePrice != null ? ` · ${money(a.salePrice)}` : ''}
                  </span>
                ) : a.auditStatus ? (
                  formatLabel(a.auditStatus)
                ) : (
                  '—'
                )}
              </td>
              <td className="px-4 py-2 whitespace-nowrap text-neutral-600">
                {a.movedToPalletAt ? new Date(a.movedToPalletAt).toLocaleString('en-GB') : '—'}
              </td>
              <td className="px-4 py-2 text-neutral-600">{a.movedToPalletByName ?? '—'}</td>
              {canReturn && (
                <td className="px-4 py-2 text-right">
                  {a.soldAt ? (
                    <span className="text-xs text-neutral-400">Sold</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => remove(a.id, a.name)}
                      disabled={busy === a.id}
                      aria-label={`Remove ${a.name} from this pallet`}
                      className="text-xs text-neutral-700 underline hover:text-neutral-950 disabled:opacity-50"
                    >
                      {busy === a.id ? 'Removing…' : 'Remove'}
                    </button>
                  )}
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
