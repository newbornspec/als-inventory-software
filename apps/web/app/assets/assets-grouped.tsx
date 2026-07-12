'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Batch } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import { formatLabel } from '@/lib/asset-options';

type LotAssets = { loading: boolean; error: string | null; assets: Asset[] };

// Shared device table — same columns/actions as the flat Assets list, so a
// device keeps all its information whether browsed under a lot or searched flat.
function AssetRows({ assets }: { assets: Asset[] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="bg-neutral-900 text-neutral-400">
        <tr>
          <th className="px-4 py-2">Tag</th>
          <th className="px-4 py-2">Name</th>
          <th className="px-4 py-2">Category</th>
          <th className="px-4 py-2">Stock Status</th>
          <th className="px-4 py-2">Grade</th>
          <th className="px-4 py-2">Audit Status</th>
          <th className="px-4 py-2">Location</th>
        </tr>
      </thead>
      <tbody>
        {assets.map((a) => (
          <tr key={a.id} className="border-t border-neutral-800 hover:bg-neutral-900">
            <td className="px-4 py-2">
              <Link href={`/assets/${a.id}`} className="text-neutral-100 underline">
                {a.tag}
              </Link>
            </td>
            <td className="px-4 py-2">{a.name}</td>
            <td className="px-4 py-2 text-neutral-400">{a.category}</td>
            <td className="px-4 py-2">
              <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs">
                {formatLabel(a.stockStatus)}
              </span>
            </td>
            <td className="px-4 py-2 text-neutral-400">
              {a.conditionGrade ? formatLabel(a.conditionGrade) : '—'}
            </td>
            <td className="px-4 py-2 text-neutral-400">
              {a.auditStatus ? formatLabel(a.auditStatus) : '—'}
            </td>
            <td className="px-4 py-2 text-neutral-400">{a.location?.name ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AssetsGrouped({ batches, unassigned }: { batches: Batch[]; unassigned: Asset[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [cache, setCache] = useState<Record<string, LotAssets>>({});

  async function toggle(id: string) {
    const willOpen = !open[id];
    setOpen((o) => ({ ...o, [id]: willOpen }));
    if (willOpen && !cache[id]) {
      setCache((c) => ({ ...c, [id]: { loading: true, error: null, assets: [] } }));
      try {
        const res = await fetch(`/api/assets?batchId=${id}`);
        if (!res.ok) throw new Error('failed');
        const assets: Asset[] = await res.json();
        setCache((c) => ({ ...c, [id]: { loading: false, error: null, assets } }));
      } catch {
        setCache((c) => ({
          ...c,
          [id]: { loading: false, error: 'Could not load devices.', assets: [] },
        }));
      }
    }
  }

  // Only lots that actually hold devices — an empty lot is managed on the Lots page.
  const groups = batches.filter((b) => b.actualUnitCount > 0);

  if (groups.length === 0 && unassigned.length === 0) {
    return (
      <p className="mt-6 text-sm text-neutral-500">
        No devices yet. Receive a lot on the <Link href="/batches" className="underline">Lots</Link>{' '}
        page.
      </p>
    );
  }

  return (
    <div className="mt-6 space-y-3">
      {groups.map((b) => {
        const isOpen = !!open[b.id];
        const data = cache[b.id];
        return (
          <div key={b.id} className="rounded-lg border border-neutral-800 bg-neutral-900/40">
            <div className="flex items-center gap-3 px-4 py-3">
              <button
                onClick={() => toggle(b.id)}
                className="flex flex-1 items-center gap-3 text-left"
              >
                <span className="text-neutral-500">{isOpen ? '▼' : '▶'}</span>
                <span className="font-semibold text-neutral-100">{b.batchNumber}</span>
                {b.source && <span className="text-sm text-neutral-500">{b.source}</span>}
                <span className="ml-auto text-xs text-neutral-500">{b.actualUnitCount} items</span>
              </button>
              <Link
                href={`/batches/${b.id}`}
                className="shrink-0 text-xs text-neutral-400 underline"
              >
                Open lot →
              </Link>
            </div>
            {isOpen && (
              <div className="overflow-x-auto border-t border-neutral-800">
                {!data || data.loading ? (
                  <p className="px-4 py-3 text-xs text-neutral-500">Loading devices…</p>
                ) : data.error ? (
                  <p className="px-4 py-3 text-xs text-red-400">{data.error}</p>
                ) : data.assets.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-neutral-500">No devices.</p>
                ) : (
                  <AssetRows assets={data.assets} />
                )}
              </div>
            )}
          </div>
        );
      })}

      {unassigned.length > 0 && <UnassignedGroup assets={unassigned} />}
    </div>
  );
}

function UnassignedGroup({ assets }: { assets: Asset[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="text-neutral-500">{open ? '▼' : '▶'}</span>
        <span className="font-semibold text-neutral-100">No lot</span>
        <span className="text-sm text-neutral-500">devices not assigned to a lot</span>
        <span className="ml-auto text-xs text-neutral-500">{assets.length} items</span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-neutral-800">
          <AssetRows assets={assets} />
        </div>
      )}
    </div>
  );
}
