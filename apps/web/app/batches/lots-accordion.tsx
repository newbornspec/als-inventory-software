'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Check, ChevronDown, ChevronRight } from 'lucide-react';
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
    return <p className="mt-8 text-sm text-neutral-500">No lots yet.</p>;
  }

  return (
    <div className="mt-8 flex flex-col gap-4">
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
        const isTarget = lot.id === activeAuditLotId;

        return (
          <div
            key={lot.id}
            className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
          >
            <button
              onClick={() => toggle(lot.id)}
              className="flex w-full items-start justify-between gap-4 text-left"
            >
              <div className="flex items-center gap-3">
                {isOpen ? (
                  <ChevronDown className="size-4 shrink-0 text-neutral-500" />
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-neutral-500" />
                )}
                <span className="text-lg leading-7 font-semibold tracking-tight text-neutral-950">
                  {lot.batchNumber}
                </span>
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs leading-4 font-medium text-blue-700">
                  {formatLabel(lot.status)}
                </span>
                {isTarget && (
                  <span className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs leading-4 font-medium text-emerald-700">
                    <Check className="size-3" />
                    Audit target
                  </span>
                )}
              </div>
              <span className="shrink-0 text-sm leading-5 text-neutral-500">
                {scanned}
                {expected != null ? ` / ${expected}` : ''} items
              </span>
            </button>

            <div className="mt-4 grid grid-cols-2 gap-4 text-sm leading-5 sm:grid-cols-3 lg:grid-cols-6">
              <Meta label="Owner" value={lot.owner?.name} />
              <Meta label="Supplier" value={lot.source} />
              <Meta label="PO" value={lot.purchaseOrder} />
              <Meta
                label="Created"
                value={lot.createdAt ? new Date(lot.createdAt).toLocaleDateString('en-GB') : null}
              />
              <Meta label="Received" value={lot.receivedDate} />
              <Meta label="Location" value={lot.location?.name} />
            </div>

            {/* Reconciliation progress — how much of the expected count is in. */}
            {pct != null && (
              <div className="mt-4">
                <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
                  <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1.5 text-xs text-neutral-500">
                  {scanned} / {expected} scanned · {lot.audited} audited
                </div>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Chip label="Total" value={scanned} />
              <Chip label="Audited" value={lot.audited} tone={lot.audited > 0 ? 'emerald' : undefined} />
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
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-end gap-6 text-sm leading-5">
              {isTarget ? (
                <span className="flex items-center gap-2 font-medium text-neutral-950">
                  <Check className="size-4" />
                  Audit target
                </span>
              ) : (
                <button
                  onClick={() => makeAuditTarget(lot.id)}
                  className="font-medium text-neutral-500 transition-colors hover:text-neutral-950"
                >
                  Set audit target
                </button>
              )}
              {canExport && (
                <a
                  href={`/api/batches/${lot.id}/report`}
                  className="font-medium text-neutral-500 transition-colors hover:text-neutral-950"
                >
                  Export to Excel
                </a>
              )}
              <Link
                href={`/batches/${lot.id}`}
                className="flex items-center gap-1 font-medium text-neutral-500 transition-colors hover:text-neutral-950"
              >
                Open lot
                <ArrowRight className="size-4" />
              </Link>
            </div>

            {isOpen && (
              <div className="mt-4 overflow-x-auto rounded-xl border border-neutral-200">
                {!data || data.loading ? (
                  <p className="px-4 py-3 text-xs text-neutral-500">Loading assets…</p>
                ) : data.error ? (
                  <p className="px-4 py-3 text-xs text-red-600">{data.error}</p>
                ) : data.assets.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-neutral-500">
                    No assets scanned into this lot yet.
                  </p>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead className="bg-neutral-50 text-neutral-500">
                      <tr>
                        <th className="px-4 py-2 font-medium">Name</th>
                        <th className="px-4 py-2 font-medium">Category</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                        <th className="px-4 py-2 font-medium">Grade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.assets.map((a) => (
                        <tr key={a.id} className="border-t border-neutral-200">
                          <td className="px-4 py-2">
                            <Link
                              href={`/assets/${a.id}`}
                              className="font-medium text-[#2b7fff] hover:underline"
                            >
                              {a.name}
                            </Link>
                          </td>
                          <td className="px-4 py-2 text-neutral-500">{a.category}</td>
                          <td className="px-4 py-2 text-neutral-500">
                            {formatLabel(a.stockStatus)}
                          </td>
                          <td className="px-4 py-2 text-neutral-500">
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
        );
      })}
    </div>
  );
}

function Meta({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <span className="text-neutral-500">{label}: </span>
      <span className="font-medium break-words text-neutral-950">{value || '—'}</span>
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
  // Tone carries meaning: pending/missing need attention, scrap/extra are
  // problems, audited/ready are good. Flat grey when the count is zero.
  const cls =
    tone === 'amber'
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : tone === 'red'
        ? 'border-red-200 bg-red-50 text-red-700'
        : tone === 'emerald'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-neutral-200 bg-neutral-100 text-neutral-700';
  return (
    <span
      className={`rounded-md border px-2.5 py-1 text-xs leading-4 font-medium ${cls}`}
    >
      {label} {value}
    </span>
  );
}
