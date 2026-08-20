import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import { deletePallet, type Pallet } from '@/lib/actions/pallets';
import type { LookupValue } from '@/lib/actions/lookups';
import { getLocations } from '@/lib/data';
import { Nav } from '@/app/components/nav';
import { formatLabel, ramCell } from '@/lib/asset-options';
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
  const [pallet, user, lookups] = await Promise.all([
    loadPallet(id),
    getSessionUser(),
    // Both layouts draw their dropdowns from here now. Failing soft keeps the
    // pallet readable if the lookup endpoint is down — the inputs simply offer
    // no suggestions rather than the page 500ing.
    apiFetch<LookupValue[]>('/lookups').catch(() => [] as LookupValue[]),
  ]);
  const canManage =
    user?.role === 'admin' || user?.role === 'manager' || user?.role === 'technician';
  const canDelete = user?.role === 'admin';
  // Both downloads carry purchase costs and their endpoints are ADMIN+MANAGER.
  // The Export button was previously shown to technicians too, so they got a
  // 403 download page instead of a file.
  const canSeeCosts = user?.role === 'admin' || user?.role === 'manager';

  // A Layout 2 pallet always opens back into its Excel-style grid editor —
  // spec pallets are edited as a grid for their whole life, not just at
  // creation. Layout 1 pallets keep the variant view below.
  if (pallet.entryLayout === 'spec') {
    const locations = await getLocations();
    const initialRows = (pallet.lines ?? []).map((l) => ({
      lineId: l.id,
      manufacturer: l.product?.manufacturer ?? '',
      model: l.product?.model ?? (l.product ? '' : l.variant),
      chassis: l.product?.chassis ?? '',
      cpu: l.product?.cpu ?? '',
      gen: l.product?.gen ?? '',
      // Matches SPEC_RAM's options and the editor's own rebuild after a save;
      // they disagreed once and put "16 GB" beside an identical "16GB".
      ram: ramCell(l.product?.ramGb),
      storage: l.product?.storage ?? '',
      quantity: String(l.quantity),
    }));

    return (
      <>
        <Nav />
        <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
          <Link href="/pallets" className="text-sm text-neutral-700 hover:text-neutral-950">
            <span aria-hidden="true">← </span>Back to Pallets
          </Link>

          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">{pallet.palletNumber}</h1>
              <p className="mt-1 text-sm text-neutral-500">
                Specification table pallet · {pallet.totalQuantity} units ·{' '}
                {formatLabel(pallet.status)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
              {canSeeCosts && (
                <a
                  href={`/api/pallets/${pallet.id}/report`}
                  className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
                >
                  Export to Excel
                </a>
              )}
              {canDelete && (
                <form action={deletePallet.bind(null, pallet.id)}>
                  <button
                    type="submit"
                    className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
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
        </main>
    </>
    );
  }

  const estValue = (pallet.lines ?? []).reduce(
    (sum, l) => sum + (l.unitCost != null ? l.unitCost * l.quantity : 0),
    0,
  );

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <Link href="/pallets" className="text-sm text-neutral-700 hover:text-neutral-950">
          <span aria-hidden="true">← </span>Back to Pallets
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{pallet.palletNumber}</h1>
            <p className="mt-1 text-sm text-neutral-500">
              {pallet.description ?? 'No description'} · {pallet.location?.name ?? 'Unassigned'}
            </p>
            {pallet.status === 'shipped' && pallet.shippedAt && (
              <p className="mt-1 text-sm text-amber-700">
                Shipped on {new Date(pallet.shippedAt).toLocaleString('en-GB')}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canManage && (
              <SellPalletButton
                palletId={pallet.id}
                palletNumber={pallet.palletNumber}
                totalQuantity={pallet.totalQuantity}
              />
            )}
            {canSeeCosts && (
              <a
                href={`/api/pallets/${pallet.id}/report`}
                className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
              >
                Export to Excel
              </a>
            )}
            {/* Layout 1 only: the sheet is priced from unit_cost, which Layout 2
                never captures — its grid has no cost column, so the document
                would print a page of dashes. */}
            {canSeeCosts && (
              <a
                href={`/api/pallets/${pallet.id}/costing`}
                className="rounded-md border border-[var(--control-border)] px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Costing sheet
              </a>
            )}
            {/* A link, not a download: an invoice needs buyer and VAT details
                collected first, and raising one permanently spends a number. */}
            {canSeeCosts && (
              <Link
                href={`/pallets/${pallet.id}/invoice`}
                className="rounded-md border border-[var(--control-border)] px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Invoice…
              </Link>
            )}
            {canDelete && (
              <form action={deletePallet.bind(null, pallet.id)}>
                <button
                  type="submit"
                  className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                >
                  Delete
                </button>
              </form>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-neutral-500">
              Supplier
            </span>
            {canManage ? (
              <PalletSupplier palletId={pallet.id} supplier={pallet.supplier} />
            ) : (
              <span className="text-neutral-900">{pallet.supplier || '—'}</span>
            )}
            <span className="text-xs text-neutral-600">who this pallet was bought from</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-neutral-500">
              Buyer
            </span>
            {canManage ? (
              <PalletBuyer palletId={pallet.id} buyer={pallet.buyer} />
            ) : (
              <span className="text-neutral-900">{pallet.buyer || '—'}</span>
            )}
            <span className="text-xs text-neutral-600">who this pallet is being sold to</span>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-lg border border-neutral-200 bg-white p-4">
            <div className="text-2xl font-semibold">{pallet.totalQuantity}</div>
            <div className="mt-1 text-sm text-neutral-500">Total units</div>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-white p-4">
            <div className="text-2xl font-semibold">{pallet.lineCount}</div>
            <div className="mt-1 text-sm text-neutral-500">Variants</div>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-white p-4">
            <div className="text-2xl font-semibold">{estValue > 0 ? money(estValue) : '—'}</div>
            <div className="mt-1 text-sm text-neutral-500">Est. value</div>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-white p-4">
            {canManage ? (
              <PalletStatusSelect palletId={pallet.id} status={pallet.status} />
            ) : (
              <div className="text-2xl font-semibold">{formatLabel(pallet.status)}</div>
            )}
            <div className="mt-1 text-sm text-neutral-500">Status</div>
          </div>
        </div>

        {/* Was max-w-5xl, which capped this at 1024px. That was comfortable for
            the old six-column table; with nine it squeezed every control until
            "Frameless" read "Fram". The cards above already span the full width,
            so removing the cap also lines this section up with them. */}
        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-500">Contents by variant</h2>
          <PalletLines
            palletId={pallet.id}
            lines={pallet.lines ?? []}
            canManage={canManage}
            lookups={lookups}
          />
        </section>
      </main>
  </>
  );
}
