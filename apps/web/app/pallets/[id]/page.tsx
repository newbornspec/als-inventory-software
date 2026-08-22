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
import { ContributedLines, MergeHistory } from './merge-history';
import { PalletAssets } from './pallet-assets';

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
  // A merged pallet is a record, not stock: its lines have moved to the pallet
  // that replaced it. Folding this into canManage/canDelete freezes every
  // mutating affordance on the page at once — status, sell, delete, the spec
  // editor, the line editors — rather than gating eight of them separately and
  // missing the ninth. The API refuses these anyway; this stops offering
  // buttons that would 409.
  const isMerged = pallet.status === 'merged';
  const canManage =
    (user?.role === 'admin' || user?.role === 'manager' || user?.role === 'technician') &&
    !isMerged;
  const canDelete = user?.role === 'admin' && !isMerged;
  // Both downloads carry purchase costs and their endpoints are ADMIN+MANAGER.
  // The Export button was previously shown to technicians too, so they got a
  // 403 download page instead of a file.
  const canSeeCosts = user?.role === 'admin' || user?.role === 'manager';

  // An asset pallet holds serialized DEVICES, not quantity lines — its page is
  // the device table plus removal, and none of the line machinery (spec grid,
  // line editors, sell-as-pallet) applies. The API refuses those anyway; this
  // page just doesn't offer them.
  if (pallet.entryLayout === 'asset') {
    const devices = pallet.assets ?? [];
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
                Serialized device pallet · {pallet.totalQuantity}{' '}
                device{pallet.totalQuantity === 1 ? '' : 's'} · {formatLabel(pallet.status)}
              </p>
              <p className="mt-1 max-w-2xl text-xs text-neutral-500">
                Devices here stay in the Assets register and are sold individually from their
                own pages. Selling or merging this pallet as one unit isn&rsquo;t supported yet.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`/api/pallets/${pallet.id}/report`}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
              >
                Export to Excel
              </a>
              {canDelete && devices.length === 0 && (
                <form action={deletePallet.bind(null, pallet.id)}>
                  <button
                    type="submit"
                    className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                  >
                    Delete pallet
                  </button>
                </form>
              )}
            </div>
          </div>

          <PalletAssets palletId={pallet.id} assets={devices} canMove={canManage} />
        </main>
      </>
    );
  }

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

          <MergeHistory pallet={pallet} />

          {isMerged && (
            <ContributedLines
              lines={pallet.contributedLines ?? []}
              destination={pallet.mergedInto?.palletNumber ?? null}
            />
          )}

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
          ) : isMerged ? null : (
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
            {/* Costing sheet and Invoice… deliberately absent. Both are being
                rebuilt as one general costing/invoicing system rather than
                per-pallet documents, so the pallet-scoped versions were
                removed rather than left to diverge from their replacements.
                Existing invoices are untouched and still readable by id. */}
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

        <MergeHistory pallet={pallet} />

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

        {isMerged && (
          <ContributedLines
            lines={pallet.contributedLines ?? []}
            destination={pallet.mergedInto?.palletNumber ?? null}
          />
        )}
      </main>
  </>
  );
}
