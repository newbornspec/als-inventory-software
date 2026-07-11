import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import { deletePallet, type Pallet } from '@/lib/actions/pallets';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';
import { PalletStatusSelect } from './status-select';
import { PalletLines } from './pallet-lines';

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
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const canDelete = user?.role === 'admin';

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{pallet.palletNumber}</h1>
            <p className="mt-1 text-sm text-neutral-400">
              {pallet.description ?? 'No description'} · {pallet.location?.name ?? 'Unassigned'}
            </p>
          </div>
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

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="text-2xl font-semibold">{pallet.totalQuantity}</div>
            <div className="mt-1 text-sm text-neutral-400">Total units</div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="text-2xl font-semibold">{pallet.lineCount}</div>
            <div className="mt-1 text-sm text-neutral-400">Variants</div>
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

        <section className="mt-8 max-w-2xl">
          <h2 className="text-sm font-medium text-neutral-400">Contents by variant</h2>
          <PalletLines palletId={pallet.id} lines={pallet.lines ?? []} canManage={canManage} />
        </section>
      </div>
    </main>
  );
}
