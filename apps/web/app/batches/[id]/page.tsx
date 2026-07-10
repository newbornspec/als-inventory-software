import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Batch, Lot } from '@/lib/actions/batches';
import type { Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';
import { NewLotForm } from './new-lot-form';
import { BatchStatusSelect } from './status-select';

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  const [batch, assets, lots] = await Promise.all([
    apiFetch<Batch>(`/batches/${id}`),
    apiFetch<Asset[]>(`/assets?batchId=${id}`),
    apiFetch<Lot[]>(`/lots?batchId=${id}`),
  ]);

  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const expected = batch.expectedUnitCount;
  const discrepancy = expected != null ? batch.actualUnitCount - expected : null;

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <h1 className="text-2xl font-semibold">{batch.batchNumber}</h1>
        <p className="mt-1 text-sm text-neutral-400">{batch.source ?? 'No supplier recorded'}</p>

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

        <div className="mt-8 grid gap-8 md:grid-cols-2">
          <section>
            <h2 className="text-sm font-medium text-neutral-400">
              Assets in this lot ({assets.length})
            </h2>
            <ul className="mt-3 space-y-1">
              {assets.map((a) => (
                <li key={a.id}>
                  <Link href={`/assets/${a.id}`} className="text-sm text-neutral-200 underline">
                    {a.tag}
                  </Link>
                  <span className="ml-2 text-xs text-neutral-500">{a.name}</span>
                </li>
              ))}
              {assets.length === 0 && (
                <li className="text-sm text-neutral-500">
                  No assets scanned into this lot yet — use Receiving mode on the Scan page.
                </li>
              )}
            </ul>
          </section>

          <section>
            <h2 className="text-sm font-medium text-neutral-400">Sub-lots ({lots.length})</h2>
            <ul className="mt-3 space-y-2">
              {lots.map((lot) => (
                <li key={lot.id} className="rounded-md border border-neutral-800 p-2 text-sm">
                  <div className="text-neutral-200">{lot.lotNumber}</div>
                  {lot.description && <div className="text-neutral-500">{lot.description}</div>}
                  <div className="text-xs text-neutral-500">
                    {lot.actualUnitCount} / {lot.expectedUnitCount ?? '—'} units
                  </div>
                </li>
              ))}
            </ul>
            {canManage && <NewLotForm batchId={batch.id} />}
          </section>
        </div>
      </div>
    </main>
  );
}
