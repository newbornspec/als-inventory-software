import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import type { Batch, Lot, ReconciliationResult } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';
import { NewLotForm } from './new-lot-form';
import { BatchStatusSelect } from './status-select';
import { ImportExpected } from './import-expected';
import { LotCost } from './lot-cost';
import { LotAssets } from './lot-assets';
import { AddAssetForm } from './add-asset-form';
import { DeleteSubLotButton } from './delete-sublot-button';

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

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  const [batch, assets, lots, recon, allBatches] = await loadBatch(id);

  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const canDelete = user?.role === 'admin';
  const otherBatches = allBatches
    .filter((b) => b.id !== batch.id)
    .map((b) => ({ id: b.id, batchNumber: b.batchNumber, source: b.source }));
  const expected = batch.expectedUnitCount;
  const discrepancy = expected != null ? batch.actualUnitCount - expected : null;

  // Roll-up: how many of the lot's devices are grouped into sub-lots.
  const groupedCount = lots.reduce((sum, l) => sum + l.actualUnitCount, 0);
  const ungroupedCount = Math.max(0, assets.length - groupedCount);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <Breadcrumbs
          items={[
            { label: 'Dashboard', href: '/dashboard' },
            { label: 'Lots', href: '/batches' },
            { label: batch.batchNumber },
          ]}
        />
        <div className="mt-3 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{batch.batchNumber}</h1>
            <p className="mt-1 text-sm text-neutral-400">
              {batch.source ?? 'No supplier recorded'}
            </p>
          </div>
          {canManage && (
            <div className="flex shrink-0 gap-2">
              <a
                href={`/api/batches/${batch.id}/erasure-certificate`}
                className="rounded-md border border-emerald-800 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-950/40"
              >
                Erasure certificate (PDF)
              </a>
              <a
                href={`/api/batches/${batch.id}/report`}
                className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900"
              >
                Export to Excel
              </a>
            </div>
          )}
        </div>

        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Owner</dt>
            <dd className="text-neutral-200">{batch.owner?.name ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Created by</dt>
            <dd className="text-neutral-200">
              {batch.createdBy?.name ?? '—'}
              <span className="ml-1 text-xs text-neutral-500">
                {batch.createdAt ? `· ${new Date(batch.createdAt).toLocaleDateString('en-GB')}` : ''}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Purchase order</dt>
            <dd className="text-neutral-200">{batch.purchaseOrder ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Delivery note</dt>
            <dd className="text-neutral-200">{batch.deliveryNote ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Purchase date</dt>
            <dd className="text-neutral-200">{batch.purchaseDate ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Received date</dt>
            <dd className="text-neutral-200">{batch.receivedDate ?? '—'}</dd>
          </div>
        </dl>

        <div className="mt-4 flex items-center gap-3 text-sm">
          <span className="text-xs uppercase tracking-wide text-neutral-500">Lot cost</span>
          {canManage ? (
            <LotCost batchId={batch.id} totalCost={batch.totalCost} />
          ) : (
            <span className="text-neutral-200">
              {batch.totalCost != null ? money(batch.totalCost) : '—'}
            </span>
          )}
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="text-2xl font-semibold">{batch.actualUnitCount}</div>
            <div className="mt-1 text-sm text-neutral-400">Actual units (scanned)</div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="text-2xl font-semibold">{expected ?? '—'}</div>
            <div className="mt-1 text-sm text-neutral-400">Expected units (manifest)</div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div
              className={
                'text-2xl font-semibold ' +
                (discrepancy == null || discrepancy === 0
                  ? ''
                  : discrepancy < 0
                    ? 'text-amber-400'
                    : 'text-red-400')
              }
            >
              {discrepancy == null ? '—' : discrepancy > 0 ? `+${discrepancy}` : discrepancy}
            </div>
            <div className="mt-1 text-sm text-neutral-400">
              {discrepancy == null
                ? 'No manifest count'
                : discrepancy === 0
                  ? 'Reconciled'
                  : discrepancy < 0
                    ? 'Short (missing units)'
                    : 'Over (unexpected units)'}
            </div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            {canManage ? (
              <BatchStatusSelect batchId={batch.id} status={batch.status} />
            ) : (
              <div className="text-2xl font-semibold">{formatLabel(batch.status)}</div>
            )}
            <div className="mt-1 text-sm text-neutral-400">Status</div>
          </div>
        </div>

        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-neutral-400">Expected inventory &amp; receiving diff</h2>
            {recon.summary.expectedSerialized > 0 && (
              <div className="flex gap-2 text-xs">
                <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-emerald-400">
                  {recon.summary.found} found
                </span>
                <span className="rounded-full bg-amber-950 px-2 py-0.5 text-amber-400">
                  {recon.summary.missing} missing
                </span>
                <span className="rounded-full bg-red-950 px-2 py-0.5 text-red-400">
                  {recon.summary.extra} extra
                </span>
              </div>
            )}
          </div>

          {recon.lines.length > 0 || recon.quantityOnly.length > 0 ? (
            <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-900 text-neutral-400">
                  <tr>
                    <th className="px-3 py-2">Serial / Tag</th>
                    <th className="px-3 py-2">Manufacturer</th>
                    <th className="px-3 py-2">Model</th>
                    <th className="px-3 py-2">CPU</th>
                    <th className="px-3 py-2">RAM</th>
                    <th className="px-3 py-2">Grade</th>
                    <th className="px-3 py-2">Qty</th>
                    <th className="px-3 py-2">Received</th>
                  </tr>
                </thead>
                <tbody>
                  {recon.lines.map((l) => (
                    <tr key={l.expected.id} className="border-t border-neutral-800">
                      <td className="px-3 py-2 text-neutral-300">
                        {l.expected.serialNumber ?? l.expected.assetTag ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-neutral-400">{l.expected.manufacturer ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-400">{l.expected.model ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-400">{l.expected.cpu ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-400">{l.expected.ramGb ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-400">{l.expected.grade ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-300">{l.expected.quantity}</td>
                      <td className="px-3 py-2">
                        {l.status === 'found' ? (
                          <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs text-emerald-400">
                            Found
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-950 px-2 py-0.5 text-xs text-amber-400">
                            Missing
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {recon.quantityOnly.map((it) => (
                    <tr key={it.id} className="border-t border-neutral-800">
                      <td className="px-3 py-2 text-neutral-500">— (qty only)</td>
                      <td className="px-3 py-2 text-neutral-400">{it.manufacturer ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-400">{it.model ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-400">{it.cpu ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-400">{it.ramGb ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-400">{it.grade ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral-300">{it.quantity}</td>
                      <td className="px-3 py-2 text-neutral-600">n/a</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 text-sm text-neutral-500">No supplier list imported yet.</p>
          )}

          {recon.summary.expectedSerialized > 0 && recon.extras.length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-red-400">
                Extra — scanned but not on the supplier list ({recon.extras.length})
              </div>
              <ul className="mt-1 flex flex-wrap gap-2">
                {recon.extras.map((e) => (
                  <li
                    key={e.id}
                    className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-300"
                  >
                    {e.tag}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canManage && (
            <div className="mt-3 max-w-2xl">
              <ImportExpected
                batchId={batch.id}
                hasExisting={recon.lines.length > 0 || recon.quantityOnly.length > 0}
              />
            </div>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-400">
            Assets in this lot ({assets.length})
          </h2>
          <LotAssets
            assets={assets}
            subLots={lots}
            batchId={batch.id}
            otherBatches={otherBatches}
            canManage={canManage}
            canDelete={canDelete}
          />
          {canManage && <AddAssetForm batchId={batch.id} subLots={lots} />}
        </section>

        <div className="mt-8">
          <section>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-neutral-400">Sub-lots ({lots.length})</h2>
              {lots.length > 0 && (
                <span className="text-xs text-neutral-500">
                  {groupedCount} of {assets.length} grouped · {ungroupedCount} unassigned
                </span>
              )}
            </div>
            <ul className="mt-3 space-y-2">
              {lots.map((lot) => {
                const pct =
                  lot.expectedUnitCount && lot.expectedUnitCount > 0
                    ? Math.min(100, Math.round((lot.actualUnitCount / lot.expectedUnitCount) * 100))
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
                  <li key={lot.id} className="rounded-md border border-neutral-800 p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={`/batches/${batch.id}/sublots/${lot.id}`}
                        className="font-medium text-neutral-200 underline"
                      >
                        {lot.lotNumber}
                      </Link>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
                          {formatLabel(lot.status)}
                        </span>
                        {canDelete && (
                          <DeleteSubLotButton
                            lotId={lot.id}
                            lotNumber={lot.lotNumber}
                            batchId={batch.id}
                            assetCount={lot.actualUnitCount}
                          />
                        )}
                      </div>
                    </div>
                    {specLabel && (
                      <div className="mt-0.5 text-neutral-400">{specLabel}</div>
                    )}
                    <div className="mt-2 flex items-baseline justify-between text-xs text-neutral-500">
                      <span>
                        <span className="text-neutral-300">{lot.actualUnitCount}</span> asset
                        {lot.actualUnitCount === 1 ? '' : 's'}
                        {lot.expectedUnitCount != null
                          ? ` / ${lot.expectedUnitCount} expected`
                          : ''}
                      </span>
                      {pct != null && <span>{pct}%</span>}
                    </div>
                    {pct != null && (
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                        <div
                          className="h-full rounded-full bg-emerald-600"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                    <Link
                      href={`/batches/${batch.id}/sublots/${lot.id}`}
                      className="mt-2 inline-block text-xs text-neutral-400 underline"
                    >
                      View contents →
                    </Link>
                  </li>
                );
              })}
              {lots.length === 0 && (
                <li className="text-sm text-neutral-500">
                  No sub-lots yet. Create one below to group these devices by specification.
                </li>
              )}
            </ul>
            {canManage && <NewLotForm batchId={batch.id} />}
          </section>
        </div>
      </div>
    </main>
  );
}
