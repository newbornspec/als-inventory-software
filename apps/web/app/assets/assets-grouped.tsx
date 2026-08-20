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
          <caption className="sr-only">Devices in this lot</caption>
      <thead className="bg-neutral-50 text-neutral-500">
        <tr>
          <th scope="col" className="px-4 py-2">Name</th>
          <th scope="col" className="px-4 py-2">Category</th>
          <th scope="col" className="px-4 py-2">Stock Status</th>
          <th scope="col" className="px-4 py-2">Grade</th>
          <th scope="col" className="px-4 py-2">Audit Status</th>
          <th scope="col" className="px-4 py-2">Location</th>
        </tr>
      </thead>
      <tbody>
        {assets.map((a) => (
          <tr key={a.id} className="border-t border-neutral-200 hover:bg-white">
            <td className="px-4 py-2">
              <Link href={`/assets/${a.id}`} className="text-neutral-950 underline">
                {a.name}
              </Link>
            </td>
            <td className="px-4 py-2 text-neutral-500">{a.category}</td>
            <td className="px-4 py-2">
              <span className="rounded-full border border-[var(--field-border)] px-2 py-0.5 text-xs">
                {formatLabel(a.stockStatus)}
              </span>
            </td>
            <td className="px-4 py-2 text-neutral-500">
              {a.conditionGrade ? formatLabel(a.conditionGrade) : '—'}
            </td>
            <td className="px-4 py-2 text-neutral-500">
              {a.auditStatus ? formatLabel(a.auditStatus) : '—'}
            </td>
            <td className="px-4 py-2 text-neutral-500">{a.location?.name ?? '—'}</td>
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
          <div key={b.id} className="rounded-lg border border-neutral-200 bg-neutral-50">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <h2 className="flex min-w-0 flex-1">
                <button
                  onClick={() => toggle(b.id)}
                  aria-expanded={isOpen}
                  aria-controls={`lot-devices-${b.id}`}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left"
                >
                  <span aria-hidden="true" className="text-neutral-600">
                    {isOpen ? '▼' : '▶'}
                  </span>
                  <span className="font-semibold text-neutral-950">{b.batchNumber}</span>
                  {b.source && <span className="text-sm text-neutral-600">{b.source}</span>}
                  <span className="ml-auto text-xs text-neutral-600">
                    {b.actualUnitCount} items
                  </span>
                </button>
              </h2>
              <Link
                href={`/batches/${b.id}`}
                aria-label={`Open ${b.batchNumber}`}
                className="shrink-0 text-xs text-neutral-700 underline"
              >
                Open lot <span aria-hidden="true">→</span>
              </Link>
            </div>
            {isOpen && (
              <div
                id={`lot-devices-${b.id}`}
                role="region"
                aria-label={`Devices in ${b.batchNumber}`}
                tabIndex={0}
                className="overflow-x-auto border-t border-neutral-200"
              >
                {!data || data.loading ? (
                  <p role="status" className="px-4 py-3 text-xs text-neutral-600">Loading devices…</p>
                ) : data.error ? (
                  <p role="alert" className="px-4 py-3 text-xs text-red-700">{data.error}</p>
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
    <div className="rounded-lg border border-neutral-200 bg-neutral-50">
      <h2>
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls="devices-no-lot"
          className="flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          <span aria-hidden="true" className="text-neutral-600">
            {open ? '▼' : '▶'}
          </span>
          <span className="font-semibold text-neutral-950">No lot</span>
          <span className="text-sm text-neutral-600">devices not assigned to a lot</span>
          <span className="ml-auto text-xs text-neutral-600">{assets.length} items</span>
        </button>
      </h2>
      {open && (
        <div
          id="devices-no-lot"
          role="region"
          aria-label="Devices not assigned to a lot"
          tabIndex={0}
          className="overflow-x-auto border-t border-neutral-200"
        >
          <AssetRows assets={assets} />
        </div>
      )}
    </div>
  );
}
