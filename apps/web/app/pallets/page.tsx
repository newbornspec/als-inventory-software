import { apiFetch, getSessionAccess } from '@/lib/api-server';
import { hasPermission } from '@/lib/permissions';
import type { Pallet } from '@/lib/actions/pallets';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';
import { NewPalletButton } from './new-pallet-button';
import { PalletWorkspace } from './pallet-workspace';

// A workspace rather than a list: find → filter → select → act, without leaving
// the page.
//
// Filtering, search, sort, selection and pagination are all client-side over
// the loaded list. That is a deliberate call at this scale — the page already
// fetched every pallet, so filtering in the browser costs one render instead
// of a round trip per keystroke, and typing feels instant. If this ever grows
// past a few hundred pallets it should move server-side.
export default async function PalletsPage() {
  const [pallets, access] = await Promise.all([
    apiFetch<Pallet[]>('/pallets'),
    getSessionAccess(),
  ]);

  // Each control renders only when the API would actually allow the action —
  // the same fail-closed catalog the guard enforces, mirrored per button
  // instead of one coarse role check.
  const can = {
    create: hasPermission(access, 'pallets'),
    export: hasPermission(access, 'export'),
    merge: hasPermission(access, 'merge_pallets'),
    delete: hasPermission(access, 'delete_pallet'),
    // Status changes ride the plain pallets permission, like the single-row
    // dropdown on the detail page.
    changeStatus: hasPermission(access, 'pallets'),
  };

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
        <Breadcrumbs
          items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Pallets' }]}
        />

        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Pallets</h1>
            <p className="mt-1 text-sm text-neutral-600">
              View and manage all pallets. Filter by status to quickly find what you need.
            </p>
          </div>
          {can.create && <NewPalletButton />}
        </div>

        <PalletWorkspace pallets={pallets} can={can} />
        </div>
      </main>
    </>
  );
}
