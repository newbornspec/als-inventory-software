import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import { deletePallet, type Pallet } from '@/lib/actions/pallets';
import type { LookupValue } from '@/lib/actions/lookups';
import { getLocations } from '@/lib/data';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';
import { PalletStatusSelect } from './status-select';
import { PalletLines } from './pallet-lines';
import { PalletSupplier } from './pallet-supplier';
import { PalletBuyer } from './pallet-buyer';
import { SpecEditor } from './spec-editor';
import { SellPalletButton } from './sell-pallet-button';

// 404 (deleted pallet) -> Next's not-found page instead of a server-side crash.
async function loadPallet(id: string): Promise<Pallet> {
  try {
    return await apiFetch<Pallet>(`/pallets/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export default async function PalletDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [pallet, user] = await Promise.all([loadPallet(id), getSessionUser()]);
  const canManage =
    user?.role === 'admin' || user?.role === 'manager' || user?.role === 'technician';
  const canDelete = user?.role === 'admin';

  // A Layout 2 pallet always opens back into its Excel-style grid editor —
  // spec pallets are edited as a grid for their whole life, not just at
  // creation. Layout 1 pallets keep the variant view below.
  if (pallet.entryLayout === 'spec') {
    const [locations, lookups] = await Promise.all([
      getLocations(),
      apiFetch<LookupValue[]>('/lookups').catch(() => [] as LookupValue[]),
    ]);
    const initialRows = (pallet.lines ?? []).map((l) => ({
      lineId: l.id,
      manufacturer: l.product?.manufacturer ?? '',
      model: l.product?.model ?? (l.product ? '' : l.variant),
      chassis: l.product?.chassis ?? '',
      cpu: l.product?.cpu ?? '',
      gen: l.product?.gen ?? '',
      ram: l.product?.ramGb != null ? `${l.product.ramGb} GB` : '',
      storage: l.product?.storage ?? '',
      quantity: String(l.quantity),
    }));

    return (
      <main className="min-h-screen bg-neutral-950 text-neutral-100">
        <Nav />
        <div className="p-8">
          <Link href="/pallets" className="text-sm text-neutral-400 hover:text-neutral-200">
            ← Back to Pallets
          </Link>

          <div className="mt-3 flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">{pallet.palletNumber}</h1>
              <p className="mt-1 text-sm text-neutral-400">
                Specification table pallet · {pallet.totalQuantity} units ·{' '}
                {formatLabel(pallet.status)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {canManage && (
                <PalletStatusSelect palletId={pallet.id} status={pallet.status} />
              )}
              {canManage && (
                <SellPalletButton
                  palletId={pallet.id}
                  palletNumber={pallet.palletNumber}
                  totalQuantity={pallet.totalQuantity}
                />
              )}
              {canManage && (
                <a
                  href={`/api/pallets/${pallet.id}/report`}
                  className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900"
                >
                  Export to Excel
                </a>
              )}
              {canDelete && (
                <form action={deletePallet.bind(null, pallet.id)}>
                  <button
                    type="submit"
                    className="rounded-md border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
                  >
                    Delete
                  </button>
                </form>
              )}
            </div>
          </div>

          {canManage ? (
            <SpecEditor
              palletId={pallet.id}
              initialMeta={{
                description: pallet.description ?? '',
                supplier: pallet.supplier ?? '',
                buyer: pallet.buyer ?? '',
                locationId: pallet.locationId ?? '',
              }}
              initialRows={initialRows}
              locations={locations}
              lookups={lookups}
            />
          ) : (
            <p className="mt-6 text-sm text-neutral-500">
              You have read-only access — ask a manager to edit this pallet.
            </p>
          )}
        </div>
      </main>
    );
  }

  const estValue = (pallet.lines ?? []).reduce(
    (sum, l) => sum + (l.unitCost != null ? l.unitCost * l.quantity : 0),
    0,
  );

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <Link href="/pallets" className="text-sm text-neutral-400 hover:text-neutral-200">
          ← Back to Pallets
        </Link>

        <div className="mt-3 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{pallet.palletNumber}</h1>
            <p className="mt-1 text-sm text-neutral-400">
              {pallet.description ?? 'No description'} · {pallet.location?.name ?? 'Unassigned'}
            </p>
            {pallet.status === 'shipped' && pallet.shippedAt && (
              <p className="mt-1 text-sm text-amber-400">
                Shipped on {new Date(pallet.shippedAt).toLocaleString('en-GB')}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canManage && (
              <SellPalletButton
                palletId={pallet.id}
                palletNumber={pallet.palletNumber}
                totalQuantity={pallet.totalQuantity}
              />
            )}
            {canManage && (
              <a
                href={`/api/pallets/${pallet.id}/report`}
                className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900"
              >
                Export to Excel
              </a>
            )}
            {canDelete && (
              <form action={deletePallet.bind(null, pallet.id)}>
                <button
                  type="submit"
                  className="rounded-md border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
                >
                  Delete
                </button>
              </form>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-2 text-sm">
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-neutral-500">
              Supplier
            </span>
            {canManage ? (
              <PalletSupplier palletId={pallet.id} supplier={pallet.supplier} />
            ) : (
              <span className="text-neutral-200">{pallet.supplier || '—'}</span>
            )}
            <span className="text-xs text-neutral-600">who this pallet was bought from</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-neutral-500">
              Buyer
            </span>
            {canManage ? (
              <PalletBuyer palletId={pallet.id} buyer={pallet.buyer} />
            ) : (
              <span className="text-neutral-200">{pallet.buyer || '—'}</span>
            )}
            <span className="text-xs text-neutral-600">who this pallet is being sold to</span>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="text-2xl font-semibold">{pallet.totalQuantity}</div>
            <div className="mt-1 text-sm text-neutral-400">Total units</div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="text-2xl font-semibold">{pallet.lineCount}</div>
            <div className="mt-1 text-sm text-neutral-400">Variants</div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="text-2xl font-semibold">{estValue > 0 ? money(estValue) : '—'}</div>
            <div className="mt-1 text-sm text-neutral-400">Est. value</div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            {canManage ? (
              <PalletStatusSelect palletId={pallet.id} status={pallet.status} />
            ) : (
              <div className="text-2xl font-semibold">{formatLabel(pallet.status)}</div>
            )}
            <div className="mt-1 text-sm text-neutral-400">Status</div>
          </div>
        </div>

        <section className="mt-8 max-w-5xl">
          <h2 className="text-sm font-medium text-neutral-400">Contents by variant</h2>
          <PalletLines palletId={pallet.id} lines={pallet.lines ?? []} canManage={canManage} />
        </section>
      </div>
    </main>
  );
}
