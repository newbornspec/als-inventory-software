import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Pallet } from '@/lib/actions/pallets';
import { Nav } from '@/app/components/nav';
import { NewPalletButton } from './new-pallet-button';
import { PalletWorkspace } from './pallet-workspace';

// A workspace rather than a list: find → filter → select → act, without leaving
// the page.
//
// Filtering, search, sort and selection are all client-side over the loaded
// list. That is a deliberate call at this scale — the page already fetched every
// pallet to render the old two-table split, so filtering in the browser costs
// one render instead of a round trip per keystroke, and typing feels instant.
// If this ever grows past a few hundred pallets it should move server-side, and
// that is the point at which pagination earns its place too.
export default async function PalletsPage() {
  const [pallets, user] = await Promise.all([
    apiFetch<Pallet[]>('/pallets'),
    getSessionUser(),
  ]);
  const canCreate =
    user?.role === 'admin' || user?.role === 'manager' || user?.role === 'technician';
  // Selecting and exporting is a manager action, matching the per-pallet export
  // button that has always been admin/manager only.
  const canManage = user?.role === 'admin' || user?.role === 'manager';

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Pallets</h1>
            <p className="mt-1 text-sm text-neutral-600">
              Newest first. Shipped and sold pallets stay here — filter by status
              to narrow the list.
            </p>
          </div>
          {canCreate && <NewPalletButton />}
        </div>

        <PalletWorkspace pallets={pallets} canManage={canManage} />
      </main>
    </>
  );
}
