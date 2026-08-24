import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import type { Batch, Lot } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';
import { Section, Tile, MetricGrid } from '@/app/dashboard/components';
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
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) notFound();
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

  // Matches the parent lot page, which grants technicians the same input rights
  // under the comment "Technicians can create + input like managers". The same
  // person looking at the same device used to gain and lose the Sell, Sub-lot
  // and Move-to controls purely by drilling one level deeper.
  const canManage =
    user?.role === 'admin' || user?.role === 'manager' || user?.role === 'technician';
  const canDelete = user?.role === 'admin';
  const otherBatches = allBatches
    .filter((b) => b.id !== id)
    .map((b) => ({ id: b.id, batchNumber: b.batchNumber, source: b.source }));

  const spec =
    [lot.manufacturer, lot.model, lot.cpu, lot.ramGb ? `${lot.ramGb}GB` : null, lot.storage, lot.screenSize]
      .filter(Boolean)
      .join(' · ') || lot.description;
  // lot.actualUnitCount is now the LIVE count (sold excluded), so this headline
  // and the table below it are finally counting the same devices — it used to be
  // a plain COUNT(*) and could read "12 assets · 100%" above a list of 8.
  const held = lot.actualUnitCount;
  const soldOff = Math.max(0, (lot.totalUnitCount ?? held) - held);
  const pct =
    lot.expectedUnitCount && lot.expectedUnitCount > 0
      ? Math.min(100, Math.round((held / lot.expectedUnitCount) * 100))
      : null;

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
          <Breadcrumbs
            items={[
              { label: 'Dashboard', href: '/dashboard' },
              { label: 'Goods In', href: '/batches' },
              { label: batch.batchNumber, href: `/batches/${id}` },
              { label: lot.lotNumber },
            ]}
          />

          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">{lot.lotNumber}</h1>
                <span className="rounded-full border border-neutral-300 bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
                  {formatLabel(lot.status)}
                </span>
              </div>
              <p className="mt-1 text-sm leading-6 text-neutral-600">
                Sub-lot of{' '}
                <Link href={`/batches/${id}`} className="text-[#1a6ef5] hover:underline">
                  {batch.batchNumber}
                </Link>
                {spec ? ` · ${spec}` : ''}
              </p>
            </div>
            {canDelete && (
              <div className="shrink-0">
                <DeleteSubLotButton
                  lotId={lot.id}
                  lotNumber={lot.lotNumber}
                  batchId={id}
                  assetCount={lot.totalUnitCount ?? lot.actualUnitCount}
                  redirectTo={`/batches/${id}`}
                />
              </div>
            )}
          </div>

          <div className="mt-4">
            <MetricGrid cols={4}>
              <Tile
                label="In this sub-lot"
                value={held}
                sub={soldOff > 0 ? `${soldOff} sold on` : 'still in active inventory'}
              />
              <Tile
                label="Expected"
                value={lot.expectedUnitCount ?? '—'}
                sub={lot.expectedUnitCount != null ? 'declared for this spec' : 'no target set'}
              />
              <Tile
                label="Filled"
                value={pct != null ? `${pct}%` : '—'}
                sub={pct != null ? 'of the expected units' : 'nothing to measure against'}
              />
              <Tile label="Parent lot" value={batch.batchNumber} sub={batch.source ?? 'no supplier recorded'} />
            </MetricGrid>
          </div>

          <Section
            id="sublot-devices"
            title={`Devices (${assets.length})`}
            description={`Use the sub-lot dropdown to move a device to another bucket, or “— None —” to send it back to ${batch.batchNumber}.`}
          >
            <LotAssets
              assets={assets}
              subLots={siblings}
              batchId={id}
              otherBatches={otherBatches}
              canManage={canManage}
              canDelete={canDelete}
              scopeLabel="sub-lot"
            />
          </Section>
        </div>
      </main>
    </>
  );
}
