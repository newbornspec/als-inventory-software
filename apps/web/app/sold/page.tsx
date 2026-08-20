import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { SoldAsset, SoldPalletLine } from '@/lib/actions/sold';
import type { Batch } from '@/lib/actions/batches';
import type { Pallet } from '@/lib/actions/pallets';
import { Nav } from '@/app/components/nav';
import { SoldManager } from './sold-manager';

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
  const palletDests = pallets
    .filter((p) => p.status !== 'shipped')
    .map((p) => ({ id: p.id, label: p.palletNumber }));

  const totalUnits =
    soldAssets.length + soldPalletLines.reduce((s, l) => s + l.quantity, 0);

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Sold</h1>
            <p className="mt-1 max-w-2xl text-sm text-neutral-500">
              Everything sold, organised by where it came from — expand a lot or pallet to see its
              items, select rows for bulk actions.
              {isAdmin
                ? ' Returns go to the original location by default, or a destination you choose.'
                : ' Only an administrator can return items to inventory.'}
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold tabular-nums">{totalUnits.toLocaleString('en-GB')}</div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">units sold</div>
          </div>
        </div>

        <SoldManager
          assets={soldAssets}
          palletLines={soldPalletLines}
          batchDests={batchDests}
          palletDests={palletDests}
          isAdmin={isAdmin}
        />
      </main>
  </>
  );
}
