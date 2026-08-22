'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Check, ChevronDown, ChevronRight } from 'lucide-react';
import type { Batch } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import { setAuditLot } from '@/lib/actions/devices';
import { formatLabel } from '@/lib/asset-options';
import { DeleteBatchButton } from './delete-batch-button';
import { MoveToPallet } from './move-to-pallet';

type LotAssets = { loading: boolean; error: string | null; assets: Asset[] };

export function LotsAccordion({
  lots,
  canExport,
  canDelete,
  canMove,
  activeAuditLotId,
}: {
  lots: Batch[];
  canExport: boolean;
  canDelete: boolean;
  canMove?: boolean;
  activeAuditLotId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [cache, setCache] = useState<Record<string, LotAssets>>({});
  // Ticked devices per lot, for Move to Pallet. Keyed by lot so selections in
  // two expanded lots never bleed into one another.
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  async function makeAuditTarget(id: string) {
    await setAuditLot(id);
    router.refresh();
  }

  async function loadLot(id: string) {
    setCache((c) => ({ ...c, [id]: { loading: true, error: null, assets: [] } }));
    try {
      // onPallet=false: this table is the lot's POOL — devices already moved
      // to a pallet have left it (they're still in the Assets register).
      const res = await fetch(`/api/assets?batchId=${id}&onPallet=false`);
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

  async function toggle(id: string) {
    const willOpen = !open[id];
    setOpen((o) => ({ ...o, [id]: willOpen }));
    if (willOpen && !cache[id]) await loadLot(id);
  }

  function toggleSelected(lotId: string, assetId: string) {
    setSelected((sel) => {
      const cur = sel[lotId] ?? [];
      return {
        ...sel,
        [lotId]: cur.includes(assetId) ? cur.filter((x) => x !== assetId) : [...cur, assetId],
      };
    });
  }

  function toggleAll(lotId: string, assets: Asset[]) {
    setSelected((sel) => {
      const cur = sel[lotId] ?? [];
      const all = assets.map((a) => a.id);
      return { ...sel, [lotId]: cur.length === all.length ? [] : all };
    });
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
              aria-expanded={isOpen}
              aria-controls={`lot-panel-${lot.id}`}
              className="flex w-full flex-wrap items-start justify-between gap-x-4 gap-y-2 text-left"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                {isOpen ? (
                  <ChevronDown className="size-4 shrink-0 text-neutral-600" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-neutral-600" aria-hidden="true" />
                )}
                <h2 className="text-lg leading-7 font-semibold tracking-tight text-neutral-950">
                  {lot.batchNumber}
                </h2>
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs leading-4 font-medium text-blue-700">
                  {formatLabel(lot.status)}
                </span>
                {isTarget && (
                  <span className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs leading-4 font-medium text-emerald-700">
                    <Check className="size-3" aria-hidden="true" />
                    Audit target
                  </span>
                )}
              </div>
              <span className="text-sm leading-5 text-neutral-600">
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
                  <div className="h-full rounded-full bg-emerald-700" style={{ width: `${pct}%` }} />
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
                  <Check className="size-4" aria-hidden="true" />
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
                  aria-label={`Export ${lot.batchNumber} to Excel`}
                  className="font-medium text-neutral-700 transition-colors hover:text-neutral-950"
                >
                  Export to Excel
                </a>
              )}
              <Link
                href={`/batches/${lot.id}`}
                aria-label={`Open ${lot.batchNumber}`}
                className="flex items-center gap-1 font-medium text-neutral-700 transition-colors hover:text-neutral-950"
              >
                Open lot
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              {canDelete && (
                <DeleteBatchButton
                  batchId={lot.id}
                  batchNumber={lot.batchNumber}
                  // ?? actualUnitCount because web and API deploy independently:
                  // if this ships to Vercel before the API returns totalUnitCount,
                  // the count would be undefined and the confirmation would read
                  // "undefined devices". Falls back to the live count, which is
                  // only wrong for a lot with sold devices — and the API recounts
                  // sold-inclusive before it deletes anything either way.
                  deviceCount={lot.totalUnitCount ?? lot.actualUnitCount}
                  soldCount={Math.max(0, (lot.totalUnitCount ?? 0) - lot.actualUnitCount)}
                  // Passed through as-is: undefined means the API predates these
                  // counts, and the dialog must say "any manifest/sub-lots" rather
                  // than silently treat unknown as none.
                  manifestLineCount={lot.expectedLineCount}
                  subLotCount={lot.subLotCount}
                />
              )}
            </div>

            <div id={`lot-panel-${lot.id}`} hidden={!isOpen}>
            {isOpen && canMove && (selected[lot.id]?.length ?? 0) > 0 && (
              <MoveToPallet
                selectedIds={selected[lot.id] ?? []}
                onMoved={() => {
                  setSelected((sel) => ({ ...sel, [lot.id]: [] }));
                  void loadLot(lot.id);
                }}
              />
            )}
            {isOpen && (
              <div role="region" aria-label="Lot devices" tabIndex={0} className="mt-4 overflow-x-auto rounded-xl border border-neutral-200">
                {!data || data.loading ? (
                  <p role="status" className="px-4 py-3 text-xs text-neutral-600">Loading assets…</p>
                ) : data.error ? (
                  <p role="alert" className="px-4 py-3 text-xs text-red-700">{data.error}</p>
                ) : data.assets.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-neutral-500">
                    No assets scanned into this lot yet.
                  </p>
                ) : (
                  <table className="w-full text-left text-xs">
          <caption className="sr-only">Devices scanned into this lot</caption>
                    <thead className="bg-neutral-50 text-neutral-500">
                      <tr>
                        {canMove && (
                          <th scope="col" className="w-8 px-3 py-2">
                            <input
                              type="checkbox"
                              aria-label={`Select all devices in ${lot.batchNumber}`}
                              checked={
                                data.assets.length > 0 &&
                                (selected[lot.id]?.length ?? 0) === data.assets.length
                              }
                              onChange={() => toggleAll(lot.id, data.assets)}
                            />
                          </th>
                        )}
                        <th scope="col" className="px-4 py-2 font-medium">Name</th>
                        <th scope="col" className="px-4 py-2 font-medium">Category</th>
                        <th scope="col" className="px-4 py-2 font-medium">Status</th>
                        <th scope="col" className="px-4 py-2 font-medium">Grade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.assets.map((a) => (
                        <tr key={a.id} className="border-t border-neutral-200">
                          {canMove && (
                            <td className="w-8 px-3 py-2">
                              <input
                                type="checkbox"
                                aria-label={`Select ${a.name}`}
                                checked={(selected[lot.id] ?? []).includes(a.id)}
                                onChange={() => toggleSelected(lot.id, a.id)}
                              />
                            </td>
                          )}
                          <td className="px-4 py-2">
                            <Link
                              href={`/assets/${a.id}`}
                              className="font-medium text-[#1a6ef5] hover:underline"
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
