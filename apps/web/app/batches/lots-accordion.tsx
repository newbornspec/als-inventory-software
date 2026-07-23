'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Batch } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import { setAuditLot } from '@/lib/actions/devices';
import { formatLabel } from '@/lib/asset-options';

type LotAssets = { loading: boolean; error: string | null; assets: Asset[] };

export function LotsAccordion({
  lots,
  canExport,
  activeAuditLotId,
}: {
  lots: Batch[];
  canExport: boolean;
  activeAuditLotId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [cache, setCache] = useState<Record<string, LotAssets>>({});

  async function makeAuditTarget(id: string) {
    await setAuditLot(id);
    router.refresh();
  }

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
          [id]: { loading: false, error: 'Could not load assets.', assets: [] },
        }));
      }
    }
  }

  if (lots.length === 0) {
    return <p className="mt-6 text-sm text-neutral-500">No lots yet.</p>;
  }

  return (
    <div className="mt-6 space-y-3">
      {lots.map((lot) => {
        const expected = lot.expectedUnitCount;
        const scanned = lot.actualUnitCount;
        const missing = expected != null ? Math.max(0, expected - scanned) : null;
        const extra = expected != null ? Math.max(0, scanned - expected) : null;
        const pct =
          expected && expected > 0 ? Math.min(100, Math.round((scanned / expected) * 100)) : null;
        const pending = Math.max(0, scanned - lot.audited); // scanned but not yet audited
        const isOpen = !!open[lot.id];
        const data = cache[lot.id];

        return (
          <div key={lot.id} className="rounded-lg border border-neutral-800 bg-neutral-900/40">
            <button
              onClick={() => toggle(lot.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left"
            >
              <span className="text-neutral-500">{isOpen ? '▼' : '▶'}</span>
              <span className="font-semibold text-neutral-100">{lot.batchNumber}</span>
              <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300">
                {formatLabel(lot.status)}
              </span>
              <span className="ml-auto text-xs text-neutral-500">
                {scanned}
                {expected != null ? ` / ${expected}` : ''} items
              </span>
            </button>

            <div className="px-4 pb-3">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-400">
                <span>
                  Owner: <span className="text-neutral-300">{lot.owner?.name ?? '—'}</span>
                </span>
                <span>
                  Supplier: <span className="text-neutral-300">{lot.source ?? '—'}</span>
                </span>
                <span>
                  PO: <span className="text-neutral-300">{lot.purchaseOrder ?? '—'}</span>
                </span>
                <span>
                  Created:{' '}
                  <span className="text-neutral-300">
                    {lot.createdAt ? new Date(lot.createdAt).toLocaleDateString('en-GB') : '—'}
                  </span>
                </span>
                <span>
                  Received: <span className="text-neutral-300">{lot.receivedDate ?? '—'}</span>
                </span>
                <span>
                  Location: <span className="text-neutral-300">{lot.location?.name ?? '—'}</span>
                </span>
              </div>

              {pct != null && (
                <div className="mt-3">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
                    {scanned} / {expected} scanned · {lot.audited} audited
                  </div>
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <Chip label="Total" value={scanned} />
                <Chip
                  label="Audited"
                  value={lot.audited}
                  tone={lot.audited > 0 ? 'emerald' : undefined}
                />
                <Chip label="Pending" value={pending} tone={pending > 0 ? 'amber' : undefined} />
                {missing != null && (
                  <Chip label="Missing" value={missing} tone={missing > 0 ? 'amber' : undefined} />
                )}
                {extra != null && (
                  <Chip label="Extra" value={extra} tone={extra > 0 ? 'red' : undefined} />
                )}
                <Chip
                  label="Ready"
                  value={lot.readyForSale}
                  tone={lot.readyForSale > 0 ? 'emerald' : undefined}
                />
                <Chip label="Scrap" value={lot.scrap} tone={lot.scrap > 0 ? 'red' : undefined} />
                <Chip
                  label="Quarantine"
                  value={lot.quarantine}
                  tone={lot.quarantine > 0 ? 'amber' : undefined}
                />
                <div className="ml-auto flex items-center gap-3 self-center">
                  {lot.id === activeAuditLotId ? (
                    <span className="rounded-full border border-emerald-900 bg-emerald-950/40 px-2 py-0.5 text-xs text-emerald-300">
                      ✓ Audit target
                    </span>
                  ) : (
                    <button
                      onClick={() => makeAuditTarget(lot.id)}
                      className="text-neutral-400 underline"
                    >
                      Set audit target
                    </button>
                  )}
                  {canExport && (
                    <a
                      href={`/api/batches/${lot.id}/report`}
                      className="text-neutral-400 underline"
                    >
                      Export to Excel
                    </a>
                  )}
                  <Link href={`/batches/${lot.id}`} className="text-neutral-400 underline">
                    Open lot →
                  </Link>
                </div>
              </div>

              {isOpen && (
                <div className="mt-3 overflow-x-auto rounded-md border border-neutral-800">
                  {!data || data.loading ? (
                    <p className="px-3 py-3 text-xs text-neutral-500">Loading assets…</p>
                  ) : data.error ? (
                    <p className="px-3 py-3 text-xs text-red-400">{data.error}</p>
                  ) : data.assets.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-neutral-500">
                      No assets scanned into this lot yet.
                    </p>
                  ) : (
                    <table className="w-full text-left text-xs">
                      <thead className="text-neutral-500">
                        <tr>
                          <th className="px-3 py-2">Name</th>
                          <th className="px-3 py-2">Category</th>
                          <th className="px-3 py-2">Status</th>
                          <th className="px-3 py-2">Grade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.assets.map((a) => (
                          <tr key={a.id} className="border-t border-neutral-800">
                            <td className="px-3 py-2">
                              <Link href={`/assets/${a.id}`} className="text-neutral-200 underline">
                                {a.name}
                              </Link>
                            </td>
                            <td className="px-3 py-2 text-neutral-500">{a.category}</td>
                            <td className="px-3 py-2 text-neutral-500">
                              {formatLabel(a.stockStatus)}
                            </td>
                            <td className="px-3 py-2 text-neutral-500">
                              {a.conditionGrade ? formatLabel(a.conditionGrade) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'amber' | 'red' | 'emerald';
}) {
  const toneClass =
    tone === 'amber'
      ? 'text-amber-400'
      : tone === 'red'
        ? 'text-red-400'
        : tone === 'emerald'
          ? 'text-emerald-400'
          : 'text-neutral-300';
  return (
    <span className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1">
      <span className="text-neutral-500">{label} </span>
      <span className={toneClass}>{value}</span>
    </span>
  );
}
