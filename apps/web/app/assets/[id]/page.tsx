import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import { getLocations } from '@/lib/data';
import { deleteAsset, type Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';
import { AssetEditForm } from './edit-form';
import { AuditSection, type AssetAuditRecord } from './audit-section';

interface AssetHistoryEntry {
  id: string;
  eventType: string;
  notes: string | null;
  createdAt: string;
}

export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();

  const [asset, history, audits, locations] = await Promise.all([
    apiFetch<Asset>(`/assets/${id}`),
    apiFetch<AssetHistoryEntry[]>(`/assets/${id}/history`),
    apiFetch<AssetAuditRecord[]>(`/assets/${id}/audits`),
    getLocations(),
  ]);

  const canEdit = user?.role === 'admin' || user?.role === 'manager';
  const canDelete = user?.role === 'admin';

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{asset.name}</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Tag: <span className="text-neutral-200">{asset.tag}</span> · {asset.category}
              {asset.batchId && (
                <>
                  {' · '}
                  <Link href={`/batches/${asset.batchId}`} className="underline">
                    View purchase lot →
                  </Link>
                </>
              )}
            </p>
          </div>
          {canDelete && (
            <form action={deleteAsset.bind(null, asset.id)}>
              <button
                type="submit"
                className="rounded-md border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
              >
                Delete
              </button>
            </form>
          )}
        </div>

        <div className="mt-8 grid gap-8 md:grid-cols-2">
          <section>
            <h2 className="text-sm font-medium text-neutral-400">Details</h2>
            {canEdit ? (
              <AssetEditForm asset={asset} locations={locations} />
            ) : (
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between max-w-sm">
                  <dt className="text-neutral-500">Stock status</dt>
                  <dd>{formatLabel(asset.stockStatus)}</dd>
                </div>
                <div className="flex justify-between max-w-sm">
                  <dt className="text-neutral-500">Condition grade</dt>
                  <dd>{asset.conditionGrade ? formatLabel(asset.conditionGrade) : 'Ungraded'}</dd>
                </div>
                <div className="flex justify-between max-w-sm">
                  <dt className="text-neutral-500">Audit status</dt>
                  <dd>{asset.auditStatus ? formatLabel(asset.auditStatus) : '—'}</dd>
                </div>
                <div className="flex justify-between max-w-sm">
                  <dt className="text-neutral-500">Location</dt>
                  <dd>{asset.location?.name ?? 'Unassigned'}</dd>
                </div>
              </dl>
            )}
          </section>

          <AuditSection assetId={asset.id} audits={audits} />

          <section>
            <h2 className="text-sm font-medium text-neutral-400">History</h2>
            <ul className="mt-4 space-y-3">
              {history.map((h) => (
                <li key={h.id} className="border-l-2 border-neutral-800 pl-3 text-sm">
                  <div className="text-neutral-200">{formatLabel(h.eventType)}</div>
                  {h.notes && <div className="text-neutral-500">{h.notes}</div>}
                  <div className="text-xs text-neutral-600">
                    {new Date(h.createdAt).toLocaleString()}
                  </div>
                </li>
              ))}
              {history.length === 0 && (
                <li className="text-sm text-neutral-500">No history yet.</li>
              )}
            </ul>
          </section>

          <section>
            <h2 className="text-sm font-medium text-neutral-400">Label</h2>
            <div className="mt-4 flex items-start gap-6">
              <img
                src={`/api/assets/${asset.id}/barcode?type=qr`}
                alt={`QR code for ${asset.tag}`}
                className="h-28 w-28 rounded-md bg-white p-1"
              />
              <img
                src={`/api/assets/${asset.id}/barcode?type=code128`}
                alt={`Barcode for ${asset.tag}`}
                className="h-16 rounded-md bg-white p-1"
              />
            </div>
            <Link
              href={`/assets/${asset.id}/label`}
              className="mt-3 inline-block text-sm text-neutral-400 underline"
            >
              Open printable label →
            </Link>
          </section>
        </div>
      </div>
    </main>
  );
}
