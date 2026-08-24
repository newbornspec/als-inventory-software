import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionAccess, getSessionUser } from '@/lib/api-server';
import { hasPermission } from '@/lib/permissions';
import { TransferBatch } from '../transfer-batch';
import type { Batch, Lot, ReconciliationResult } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';
// The dashboard kit is the reference implementation of the app's card, metric
// and scroll-region shapes. Imported rather than copied a fifth time — it has no
// dashboard-specific state, and a shared design system is the point.
import { Section, Tile, MetricGrid, Empty } from '@/app/dashboard/components';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';
import { NewLotForm } from './new-lot-form';
import { BatchStatusSelect } from './status-select';
import { ImportExpected } from './import-expected';
import { LotCost } from './lot-cost';
import { ExpectedArrival } from './expected-arrival';
import { LotAssets } from './lot-assets';
import { AddAssetForm } from './add-asset-form';
import { DeleteSubLotButton } from './delete-sublot-button';
import { ReassignOwner } from './reassign-owner';
import { ManifestTable } from './manifest-table';

// 404 (deleted lot) -> Next's not-found page instead of a server-side crash.
async function loadBatch(
  id: string,
): Promise<[Batch, Asset[], Lot[], ReconciliationResult, Batch[]]> {
  try {
    return await Promise.all([
      apiFetch<Batch>(`/batches/${id}`),
      apiFetch<Asset[]>(`/assets?batchId=${id}`),
      apiFetch<Lot[]>(`/lots?batchId=${id}`),
      apiFetch<ReconciliationResult>(`/batches/${id}/expected/reconciliation`),
      apiFetch<Batch[]>('/batches'),
    ]);
  } catch (err) {
    // 404 (deleted) or 403 (a manager opening a lot they don't own) -> not-found.
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) notFound();
    throw err;
  }
}

const STATUS_TONE: Record<string, string> = {
  draft: 'border-neutral-300 bg-neutral-100 text-neutral-700',
  awaiting_arrival: 'border-blue-200 bg-blue-50 text-blue-800',
  open: 'border-blue-200 bg-blue-50 text-blue-800',
  receiving: 'border-blue-200 bg-blue-50 text-blue-800',
  closed: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  reconciled: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  sold: 'border-neutral-300 bg-neutral-100 text-neutral-700',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-1 text-sm text-neutral-900">{children}</dd>
    </div>
  );
}

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  const [batch, assets, lots, recon, allBatches] = await loadBatch(id);

  // Technicians can create + input like managers; only delete/reassign are gated.
  const canManage =
    user?.role === 'admin' || user?.role === 'manager' || user?.role === 'technician';
  const access = await getSessionAccess();
  const canMove = hasPermission(access, 'move_to_pallet');
  // The pool still movable to a pallet; register rows keep palletised devices.
  const unallocated = batch.unallocatedCount ?? assets.filter((a) => !a.palletId).length;
  const canDelete = user?.role === 'admin';
  const isAdmin = user?.role === 'admin';
  const otherBatches = allBatches
    .filter((b) => b.id !== batch.id)
    .map((b) => ({ id: b.id, batchNumber: b.batchNumber, source: b.source }));
  // Admins can reassign ownership — load the user list to choose from.
  const users = isAdmin
    ? await apiFetch<{ id: string; name: string; role: string }[]>('/users').catch(() => [])
    : [];

  // RECONCILIATION IS A GOODS-IN QUESTION: "did what the supplier declared
  // actually turn up?" It is settled on arrival and nothing that happens to the
  // devices afterwards can change the answer. It used to be derived from
  // actualUnitCount, which EXCLUDES sold devices — so selling out of a lot that
  // had reconciled perfectly made it start reporting units as missing, directly
  // above a table that still (correctly) said nothing was missing. totalUnitCount
  // is the sold-inclusive count and is the only one that answers this question.
  const received = batch.totalUnitCount;
  const declared = batch.expectedUnitCount;
  const discrepancy = declared != null ? received - declared : null;
  const soldOff = Math.max(0, batch.totalUnitCount - batch.actualUnitCount);
  const heldNow = batch.heldUnitCount ?? batch.actualUnitCount;

  // Both operands counted over the SAME population — the live devices this page
  // actually lists. Previously grouped came from Lot.actualUnitCount (a plain
  // COUNT(*), sold included) and the total from assets.length (sold excluded),
  // which let the line print "20 of 12 grouped" and clamp a real backlog of
  // ungrouped devices to zero.
  const groupedCount = assets.filter((a) => a.lotId).length;
  const ungroupedCount = assets.length - groupedCount;

  const reconciledExactly = discrepancy === 0;

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
              { label: batch.batchNumber },
            ]}
          />

          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">{batch.batchNumber}</h1>
                <span
                  className={
                    'rounded-full border px-2 py-0.5 text-xs font-medium ' +
                    (STATUS_TONE[batch.status] ?? 'border-neutral-300 bg-neutral-100 text-neutral-700')
                  }
                >
                  {formatLabel(batch.status)}
                </span>
              </div>
              <p className="mt-1 text-sm leading-6 text-neutral-600">
                {batch.source ?? 'No supplier recorded'}
                {batch.location?.name ? ` · ${batch.location.name}` : ''}
              </p>
            </div>
            {canManage && (
              <div className="flex shrink-0 flex-wrap gap-2">
                <a
                  href={`/api/batches/${batch.id}/erasure-certificate`}
                  aria-label={`Download the erasure certificate for ${batch.batchNumber}`}
                  className="rounded-md border border-[var(--control-border)] px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
                >
                  Erasure certificate
                </a>
                <a
                  href={`/api/batches/${batch.id}/report`}
                  aria-label={`Export ${batch.batchNumber} to Excel`}
                  className="rounded-md bg-[#1a6ef5] px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
                >
                  Export to Excel
                </a>
              </div>
            )}
          </div>

          <div className="mt-4">
            <MetricGrid cols={4}>
              <Tile
                label="Received"
                value={received}
                sub={
                  soldOff > 0
                    ? `${heldNow} still held · ${soldOff} sold on`
                    : `${heldNow} still held`
                }
              />
              <Tile
                label="Declared on the PO"
                value={declared ?? '—'}
                sub={
                  batch.expectedLineCount > 0
                    ? `${batch.expectedLineCount} manifest line${batch.expectedLineCount === 1 ? '' : 's'} imported`
                    : 'no manifest imported'
                }
              />
              <Tile
                label="Discrepancy"
                value={
                  discrepancy == null ? '—' : discrepancy > 0 ? `+${discrepancy}` : discrepancy
                }
                sub={
                  discrepancy == null
                    ? 'nothing declared to check against'
                    : discrepancy === 0
                      ? 'reconciled — every declared unit arrived'
                      : discrepancy < 0
                        ? 'short — declared units never arrived'
                        : 'over — units arrived that were not declared'
                }
                // Short is the graver of the two: a device that was declared for
                // destruction and never turned up is a chain-of-custody gap, not
                // a paperwork one. Colour never carries this alone — the word is
                // in the sub-line and an icon comes with the emphasis.
                emphasis={
                  discrepancy == null || discrepancy === 0
                    ? undefined
                    : discrepancy < 0
                      ? 'critical'
                      : 'alert'
                }
              />
              <Tile
                label="Unallocated"
                value={unallocated}
                sub="held here, not yet on a pallet"
              />
            </MetricGrid>
          </div>

          <Section id="lot-details" title="Lot details">
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Owner">
                {batch.owner?.name ?? '—'}
                {isAdmin && users.length > 0 && (
                  <ReassignOwner
                    batchId={batch.id}
                    batchNumber={batch.batchNumber}
                    currentOwnerId={batch.ownerId ?? null}
                    currentOwnerName={batch.owner?.name ?? null}
                    users={users}
                  />
                )}
              </Field>
              <Field label="Created by">
                {batch.createdBy?.name ?? '—'}
                {batch.createdAt && (
                  <span className="ml-1 text-xs text-neutral-500">
                    · {new Date(batch.createdAt).toLocaleDateString('en-GB')}
                  </span>
                )}
              </Field>
              <Field label="Status">
                {canManage ? (
                  <BatchStatusSelect
                    batchId={batch.id}
                    status={batch.status}
                    unitsAtRisk={batch.actualUnitCount}
                  />
                ) : (
                  formatLabel(batch.status)
                )}
              </Field>
              <Field label="Purchase order">{batch.purchaseOrder ?? '—'}</Field>
              <Field label="Delivery note">{batch.deliveryNote ?? '—'}</Field>
              <Field label="Purchase date">{batch.purchaseDate ?? '—'}</Field>
              <Field label="Expected arrival">
                {canManage ? (
                  <ExpectedArrival
                    batchId={batch.id}
                    expectedArrivalDate={batch.expectedArrivalDate}
                  />
                ) : (
                  (batch.expectedArrivalDate ?? '—')
                )}
              </Field>
              <Field label="Received date">{batch.receivedDate ?? '—'}</Field>
              <Field label="Lot cost">
                {canManage ? (
                  <LotCost batchId={batch.id} totalCost={batch.totalCost} />
                ) : batch.totalCost != null ? (
                  money(batch.totalCost)
                ) : (
                  '—'
                )}
              </Field>
              {batch.notes && (
                <div className="min-w-0 sm:col-span-2 lg:col-span-3">
                  <dt className="text-[11px] uppercase tracking-wide text-neutral-500">Notes</dt>
                  <dd className="mt-1 max-w-3xl whitespace-pre-line text-sm text-neutral-700">
                    {batch.notes}
                  </dd>
                </div>
              )}
            </dl>
          </Section>

          <Section
            id="receiving"
            title="Receiving"
            description="What the supplier said would arrive, against what was scanned in."
            action={
              recon.summary.expectedSerialized > 0 ? (
                <div className="flex shrink-0 flex-wrap gap-2 text-xs">
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800 tabular-nums">
                    {recon.summary.found} found
                  </span>
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-800 tabular-nums">
                    {recon.summary.missing} missing
                  </span>
                  <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 font-medium text-red-700 tabular-nums">
                    {recon.summary.extra} extra
                  </span>
                </div>
              ) : undefined
            }
          >
            {recon.lines.length > 0 || recon.quantityOnly.length > 0 ? (
              <ManifestTable recon={recon} />
            ) : (
              <Empty>
                No supplier list imported yet — import one below to reconcile this delivery.
              </Empty>
            )}

            {recon.summary.expectedSerialized > 0 && recon.extras.length > 0 && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
                <h3 className="text-sm font-medium text-red-800">
                  Scanned in but not on the supplier list ({recon.extras.length})
                </h3>
                <p className="mt-1 text-sm text-red-700">
                  These arrived without being declared. Open each one to confirm it belongs to this
                  delivery.
                </p>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {recon.extras.map((e) => (
                    <li key={e.id}>
                      {/* The id was always in the payload; these were dead text. */}
                      <Link
                        href={`/assets/${e.id}`}
                        aria-label={`Open ${e.name}, scanned in but not on the supplier list`}
                        className="inline-block rounded border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-100"
                      >
                        {e.tag}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {canManage && (
              <div className="mt-4 max-w-2xl">
                <ImportExpected
                  batchId={batch.id}
                  batchNumber={batch.batchNumber}
                  existingLineCount={recon.lines.length + recon.quantityOnly.length}
                />
              </div>
            )}
          </Section>

          <Section
            id="sub-lots"
            title={`Sub-lots (${lots.length})`}
            description="Spec buckets that group this lot's devices for pricing and sale."
            action={
              lots.length > 0 ? (
                <span className="shrink-0 text-xs text-neutral-500 tabular-nums">
                  {groupedCount} of {assets.length} grouped · {ungroupedCount} unassigned
                </span>
              ) : undefined
            }
          >
            {lots.length > 0 ? (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {lots.map((lot) => {
                  const pct =
                    lot.expectedUnitCount && lot.expectedUnitCount > 0
                      ? Math.min(
                          100,
                          Math.round((lot.actualUnitCount / lot.expectedUnitCount) * 100),
                        )
                      : null;
                  const spec = [
                    lot.manufacturer,
                    lot.model,
                    lot.cpu,
                    lot.ramGb ? `${lot.ramGb}GB` : null,
                    lot.storage,
                    lot.screenSize,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  const specLabel = spec || lot.description;
                  return (
                    <li
                      key={lot.id}
                      className="flex min-w-0 flex-col rounded-lg border border-neutral-200 bg-white p-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        {/* One link per card. The card used to carry two to the
                            same place, doubling every sub-lot's tab stops. */}
                        <Link
                          href={`/batches/${batch.id}/sublots/${lot.id}`}
                          className="min-w-0 text-sm font-medium text-[#1a6ef5] hover:underline"
                        >
                          {lot.lotNumber}
                        </Link>
                        <span className="shrink-0 rounded-full border border-neutral-300 bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                          {formatLabel(lot.status)}
                        </span>
                      </div>
                      {specLabel && (
                        <p className="mt-1 text-sm text-neutral-600">{specLabel}</p>
                      )}
                      <div className="mt-3 flex items-baseline justify-between gap-2 text-sm">
                        <span className="text-neutral-700 tabular-nums">
                          <span className="font-medium text-neutral-950">
                            {lot.actualUnitCount}
                          </span>{' '}
                          device{lot.actualUnitCount === 1 ? '' : 's'}
                          {lot.expectedUnitCount != null
                            ? ` of ${lot.expectedUnitCount} expected`
                            : ''}
                        </span>
                        {pct != null && (
                          <span className="text-xs text-neutral-600 tabular-nums">{pct}%</span>
                        )}
                      </div>
                      {pct != null && (
                        <span
                          aria-hidden="true"
                          className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-neutral-100"
                        >
                          <span
                            className="block h-full rounded-full bg-[#1a6ef5]"
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                      )}
                      {canDelete && (
                        <div className="mt-3 flex justify-end border-t border-neutral-200 pt-3">
                          <DeleteSubLotButton
                            lotId={lot.id}
                            lotNumber={lot.lotNumber}
                            batchId={batch.id}
                            assetCount={lot.totalUnitCount ?? lot.actualUnitCount}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty>No sub-lots yet — create one to group these devices by specification.</Empty>
            )}
            {canManage && <NewLotForm batchId={batch.id} />}
          </Section>

          <Section
            id="devices"
            title={`Devices (${assets.length})`}
            description={
              soldOff > 0
                ? `Still in this lot's active inventory. ${soldOff} sold device${soldOff === 1 ? '' : 's'} moved to the Sold archive.`
                : "Everything scanned into this lot."
            }
            action={
              canMove && unallocated > 0 ? (
                <div className="shrink-0">
                  <TransferBatch
                    batchId={batch.id}
                    batchNumber={batch.batchNumber}
                    eligibleCount={unallocated}
                  />
                </div>
              ) : undefined
            }
          >
            <LotAssets
              assets={assets}
              subLots={lots}
              batchId={batch.id}
              otherBatches={otherBatches}
              canManage={canManage}
              canDelete={canDelete}
              canMove={canMove}
              scopeLabel="lot"
            />
            {canManage && <AddAssetForm batchId={batch.id} subLots={lots} />}
          </Section>

          {reconciledExactly && recon.summary.missing === 0 && recon.summary.extra === 0 && (
            <p className="mt-4 text-xs text-neutral-500">
              This lot reconciles against both the declared unit count and the imported manifest.
            </p>
          )}
        </div>
      </main>
    </>
  );
}
