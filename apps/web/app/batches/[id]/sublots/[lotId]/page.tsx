import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import type { Batch, Lot } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';
import { formatLabel } from '@/lib/asset-options';
import { LotAssets } from '../../lot-assets';
import { DeleteSubLotButton } from '../../delete-sublot-button';

async function load(
  batchId: string,
  lotId: string,
): Promise<[Lot, Asset[], Lot[], Batch, Batch[]]> {
  try {
    return await Promise.all([
      apiFetch<Lot>(`/lots/${lotId}`),
      apiFetch<Asset[]>(`/assets?lotId=${lotId}`),
      apiFetch<Lot[]>(`/lots?batchId=${batchId}`),
      apiFetch<Batch>(`/batches/${batchId}`),
      apiFetch<Batch[]>('/batches'),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export default async function SubLotDetailPage({
  params,
}: {
  params: Promise<{ id: string; lotId: string }>;
}) {
  const { id, lotId } = await params;
  const user = await getSessionUser();
  const [lot, assets, siblings, batch, allBatches] = await load(id, lotId);

  // Guard against a mismatched URL (sub-lot that isn't in this batch).
  if (lot.batchId && lot.batchId !== id) notFound();

  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const canDelete = user?.role === 'admin';
  const otherBatches = allBatches
    .filter((b) => b.id !== id)
    .map((b) => ({ id: b.id, batchNumber: b.batchNumber, source: b.source }));

  const spec =
    [lot.manufacturer, lot.model, lot.cpu, lot.ramGb ? `${lot.ramGb}GB` : null, lot.storage, lot.screenSize]
      .filter(Boolean)
      .join(' · ') || lot.description;
  const pct =
    lot.expectedUnitCount && lot.expectedUnitCount > 0
      ? Math.min(100, Math.round((lot.actualUnitCount / lot.expectedUnitCount) * 100))
      : null;

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <Breadcrumbs
          items={[
            { label: 'Dashboard', href: '/dashboard' },
            { label: 'Lots', href: '/batches' },
            { label: batch.batchNumber, href: `/batches/${id}` },
            { label: lot.lotNumber },
          ]}
        />

        <div className="mt-3 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{lot.lotNumber}</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Sub-lot of{' '}
              <Link href={`/batches/${id}`} className="underline">
                {batch.batchNumber}
              </Link>
              {spec ? ` · ${spec}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
              {formatLabel(lot.status)}
            </span>
            {canDelete && (
              <DeleteSubLotButton
                lotId={lot.id}
                lotNumber={lot.lotNumber}
                batchId={id}
                assetCount={lot.actualUnitCount}
                redirectTo={`/batches/${id}`}
              />
            )}
          </div>
        </div>

        <div className="mt-6 max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-neutral-300">
              <span className="text-2xl font-semibold">{lot.actualUnitCount}</span> asset
              {lot.actualUnitCount === 1 ? '' : 's'}
              {lot.expectedUnitCount != null ? ` / ${lot.expectedUnitCount} expected` : ''}
            </span>
            {pct != null && <span className="text-neutral-500">{pct}%</span>}
          </div>
          {pct != null && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
              <div className="h-full rounded-full bg-emerald-600" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>

        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-400">Assets in this sub-lot</h2>
          <p className="mt-1 text-xs text-neutral-500">
            Use the dropdown to move a device to another sub-lot, or “— No sub-lot —” to send it
            back to {batch.batchNumber}.
          </p>
          <LotAssets
            assets={assets}
            subLots={siblings}
            batchId={id}
            otherBatches={otherBatches}
            canManage={canManage}
            canDelete={canDelete}
          />
        </section>
      </div>
    </main>
  );
}
