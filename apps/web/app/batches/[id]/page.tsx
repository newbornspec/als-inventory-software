import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import type { Batch, Lot, ReconciliationResult } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';
import { NewLotForm } from './new-lot-form';
import { BatchStatusSelect } from './status-select';
import { ImportExpected } from './import-expected';
import { LotCost } from './lot-cost';
import { LotAssets } from './lot-assets';

// 404 (deleted lot) -> Next's not-found page instead of a server-side crash.
async function loadBatch(
  id: string,
): Promise<[Batch, Asset[], Lot[], ReconciliationResult]> {
  try {
    return await Promise.all([
      apiFetch<Batch>(`/batches/${id}`),
      apiFetch<Asset[]>(`/assets?batchId=${id}`),
      apiFetch<Lot[]>(`/lots?batchId=${id}`),
      apiFetch<ReconciliationResult>(`/batches/${id}/expected/reconciliation`),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  const [batch, assets, lots, recon] = await loadBatch(id);

  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const expected = batch.expectedUnitCount;
  const discrepancy = expected != null ? batch.actualUnitCount - expected : null;

  // Roll-up: how many of the lot's devices are grouped into sub-lots.
  const groupedCount = lots.reduce((sum, l) => sum + l.actualUnitCount, 0);
  const ungroupedCount = Math.max(0, assets.length - groupedCount);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <BackLink href="/batches" label="Back to Lots" />
        <div className="mt-3 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{batch.batchNumber}</h1>
            <p className="mt-1 text-sm text-neutral-400">
              {batch.source ?? 'No supplier recorded'}
            </p>
          </div>
          {canManage && (
            <a
              href={`/api/batches/${batch.id}/report`}
              className="shrink-0 rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900"
            >
              Export to Excel
            </a>
          )}
        </div>

        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
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

        <div className="mt-8 grid gap-8 md:grid-cols-2">
          <section>
            <h2 className="text-sm font-medium text-neutral-400">
              Assets in this lot ({assets.length})
            </h2>
            <LotAssets
              assets={assets}
              subLots={lots}
              batchId={batch.id}
              canManage={canManage}
            />
          </section>

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
                return (
                  <li key={lot.id} className="rounded-md border border-neutral-800 p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-neutral-200">{lot.lotNumber}</span>
                      <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
                        {formatLabel(lot.status)}
                      </span>
                    </div>
                    {lot.description && (
                      <div className="mt-0.5 text-neutral-400">{lot.description}</div>
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
