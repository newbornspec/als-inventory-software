import { apiFetch, getSessionAccess } from '@/lib/api-server';
import { hasPermission, landingFor } from '@/lib/permissions';
import { redirect } from 'next/navigation';
import { getLocations } from '@/lib/data';
import type { StockLine } from '@/lib/actions/stock';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { DeviceTransfer, StockTransfer } from './transfer-forms';

// Moving inventory between locations, for both tiers that have one.
//
// Pallets are deliberately absent: a pallet has a location of its own and moves
// as a unit from its own page, so a third panel here would just be a worse way
// to do the same thing.
export default async function TransferPage() {
  const user = await getSessionAccess();
  // Same gate as adjusting stock — a transfer changes what two locations
  // hold, so it keys on 'manage_consumables', the permission that gates those
  // writes on the API. Same audience the old admin/manager check had.
  if (!hasPermission(user, 'manage_consumables')) {
    redirect(landingFor(user));
  }

  const [locations, stock] = await Promise.all([
    getLocations(),
    apiFetch<StockLine[]>('/stock').catch(() => [] as StockLine[]),
  ]);

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <BackLink href="/dashboard" label="Back to Dashboard" />
        <h1 className="mt-3 text-2xl font-semibold">Transfer stock</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-600">
          Move inventory between locations. Every move is recorded — a device
          gets a transfer entry in its own history, and consumables get a pair of
          movements showing the quantity leaving one location and arriving at the
          other.
        </p>

        {locations.length < 2 ? (
          <p className="mt-6 max-w-lg rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            You need at least two locations before anything can be transferred.
            Add one under Lookups.
          </p>
        ) : (
          <div className="mt-8 grid max-w-5xl gap-10 lg:grid-cols-2">
            <section aria-labelledby="move-devices">
              <h2 id="move-devices" className="text-base font-semibold">
                Devices
              </h2>
              <p className="mt-1 mb-4 text-sm text-neutral-600">
                Serialised units, moved by tag.
              </p>
              <DeviceTransfer locations={locations} />
            </section>

            <section aria-labelledby="move-stock">
              <h2 id="move-stock" className="text-base font-semibold">
                Consumables
              </h2>
              <p className="mt-1 mb-4 text-sm text-neutral-600">
                Quantities of an item. Moving to a location that has never held
                it creates the line there.
              </p>
              <StockTransfer locations={locations} lines={stock} />
            </section>
          </div>
        )}
      </main>
    </>
  );
}
