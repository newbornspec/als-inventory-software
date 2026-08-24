import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { SoldAsset, SoldPalletLine } from '@/lib/actions/sold';
import type { Batch } from '@/lib/actions/batches';
import type { Pallet } from '@/lib/actions/pallets';
import { Nav } from '@/app/components/nav';
import { DispatchedCard, SoldManager } from './sold-manager';

// The Sold module: everything sold, organised in the app's own hierarchy —
// devices grouped Batch → Sub-lot, pallet goods grouped by pallet — with
// search/filters, bulk selection, CSV export, and admin-only returns (to the
// original location by default, or a chosen destination).
export default async function SoldPage() {
  const user = await getSessionUser();
  const isAdmin = user?.role === 'admin';

  const [soldAssets, soldPalletLines, batches, pallets] = await Promise.all([
    apiFetch<SoldAsset[]>('/assets/sold').catch(() => [] as SoldAsset[]),
    apiFetch<SoldPalletLine[]>('/pallets/sold').catch(() => [] as SoldPalletLine[]),
    isAdmin ? apiFetch<Batch[]>('/batches').catch(() => [] as Batch[]) : Promise.resolve([] as Batch[]),
    isAdmin ? apiFetch<Pallet[]>('/pallets').catch(() => [] as Pallet[]) : Promise.resolve([] as Pallet[]),
  ]);

  const batchDests = batches.map((b) => ({ id: b.id, label: b.batchNumber }));
  // Returned stock must never land on a merged pallet: it would sit on a
  // record that holds no stock and that /inventory deliberately hides. The API
  // refuses it too — this just stops offering a destination that will 409.
  const palletDests = pallets
    .filter((p) => p.status !== 'shipped' && p.status !== 'merged')
    .map((p) => ({ id: p.id, label: p.palletNumber }));

  const totalUnits =
    soldAssets.length + soldPalletLines.reduce((s, l) => s + l.quantity, 0);

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Sold</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
              View and track all inventory that has been finalised and marked as sold. Expand a row
              for its specification, or select rows for bulk actions.
            </p>
          </div>
          <DispatchedCard units={totalUnits} />
        </div>

        <SoldManager
          assets={soldAssets}
          palletLines={soldPalletLines}
          batchDests={batchDests}
          palletDests={palletDests}
          isAdmin={isAdmin}
        />
        </div>
      </main>
  </>
  );
}
