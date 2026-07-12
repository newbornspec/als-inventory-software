import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import { getLocations } from '@/lib/data';
import { deleteAsset, type Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';
import type { RepairLog } from '@/lib/actions/repairs';
import { AssetEditForm } from './edit-form';
import { AuditSection, type AssetAuditRecord } from './audit-section';
import { RepairsSection } from './repairs-section';

interface AssetHistoryEntry {
  id: string;
  eventType: string;
  notes: string | null;
  createdAt: string;
}

interface AssetCosting {
  purchaseCost: number | null;
  lotTotalCost: number | null;
  unitsInLot: number;
  evenSplit: number | null;
  allocatedCost: number | null;
  repairsCost: number;
  salePrice: number | null;
  sold: boolean;
  profit: number | null;
  orderId: string | null;
  orderNumber: string | null;
}

// Fetch the asset + its history/audits, turning a 404 (deleted, or created
// offline and not yet synced to the server) into Next's not-found page rather
// than an unhandled server-side exception.
async function loadAsset(
  id: string,
): Promise<[Asset, AssetHistoryEntry[], AssetAuditRecord[], RepairLog[]]> {
  try {
    return await Promise.all([
      apiFetch<Asset>(`/assets/${id}`),
      apiFetch<AssetHistoryEntry[]>(`/assets/${id}/history`),
      apiFetch<AssetAuditRecord[]>(`/assets/${id}/audits`),
      apiFetch<RepairLog[]>(`/assets/${id}/repairs`),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();

  const [asset, history, audits, repairs] = await loadAsset(id);
  const locations = await getLocations();

  const canEdit = user?.role === 'admin' || user?.role === 'manager';
  const canDelete = user?.role === 'admin';

  // Costing/profit is manager+ only — fetch it lazily and never let a failure
  // take down the asset page.
  let costing: AssetCosting | null = null;
  if (canEdit) {
    try {
      costing = await apiFetch<AssetCosting>(`/reports/assets/${id}/costing`);
    } catch {
      costing = null;
    }
  }

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

          <div className="md:col-span-2">
            <RepairsSection assetId={asset.id} repairs={repairs} canManage={canEdit} />
          </div>

          {canEdit && costing && (
            <section>
              <h2 className="text-sm font-medium text-neutral-400">Costing &amp; profit</h2>
              <dl className="mt-4 max-w-sm space-y-2 text-sm">
                <div className="flex items-baseline justify-between">
                  <dt className="text-neutral-500">Allocated cost</dt>
                  <dd className="text-right">
                    {costing.allocatedCost != null ? money(costing.allocatedCost) : '—'}
                    <span className="ml-2 text-xs text-neutral-600">
                      {costing.purchaseCost != null
                        ? 'override'
                        : costing.evenSplit != null
                          ? `split of lot ÷ ${costing.unitsInLot}`
                          : 'no lot cost'}
                    </span>
                  </dd>
                </div>
                {costing.repairsCost > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-neutral-500">Repairs</dt>
                    <dd>{money(costing.repairsCost)}</dd>
                  </div>
                )}
                {costing.sold ? (
                  <>
                    <div className="flex justify-between">
                      <dt className="text-neutral-500">Sale price</dt>
                      <dd>{costing.salePrice != null ? money(costing.salePrice) : '—'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-neutral-500">Profit</dt>
                      <dd
                        className={
                          costing.profit == null
                            ? ''
                            : costing.profit > 0
                              ? 'text-emerald-400'
                              : costing.profit < 0
                                ? 'text-red-400'
                                : ''
                        }
                      >
                        {costing.profit != null ? money(costing.profit) : '—'}
                      </dd>
                    </div>
                    {costing.orderNumber && (
                      <div className="pt-1 text-xs text-neutral-500">
                        Sold on{' '}
                        <Link href={`/orders/${costing.orderId}`} className="underline">
                          {costing.orderNumber}
                        </Link>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-neutral-500">Not sold yet.</div>
                )}
              </dl>
            </section>
          )}

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
