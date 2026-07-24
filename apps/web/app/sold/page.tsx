import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { SoldAsset, SoldPalletLine } from '@/lib/actions/sold';
import type { Batch } from '@/lib/actions/batches';
import type { Pallet } from '@/lib/actions/pallets';
import { Nav } from '@/app/components/nav';
import { ReturnControl } from './return-controls';

// The archive of everything sold — serialized devices and pallet goods. Items
// here are locked out of active inventory; only an admin can send one back
// (Return to Inventory), choosing the destination lot/pallet.
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

  const date = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleString('en-GB') : '—';
  const totalUnits =
    soldAssets.length + soldPalletLines.reduce((s, l) => s + l.quantity, 0);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Sold</h1>
            <p className="mt-1 max-w-2xl text-sm text-neutral-400">
              Everything that has been sold — removed from active inventory and locked.
              {isAdmin
                ? ' As an admin you can return an item to inventory below.'
                : ' Only an administrator can return an item to inventory.'}
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold tabular-nums">{totalUnits.toLocaleString('en-GB')}</div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">units sold</div>
          </div>
        </div>

        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-300">
            Serialized devices <span className="text-neutral-500">· {soldAssets.length}</span>
          </h2>
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Manufacturer</th>
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3">Serial</th>
                  <th className="px-4 py-3">Tag</th>
                  <th className="px-4 py-3">Lot</th>
                  <th className="px-4 py-3">Sub-lot</th>
                  <th className="px-4 py-3">Date sold</th>
                  <th className="px-4 py-3">Sold by</th>
                  {isAdmin && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {soldAssets.map((a) => (
                  <tr key={a.id} className="border-t border-neutral-800">
                    <td className="px-4 py-3 text-neutral-100">{a.name}</td>
                    <td className="px-4 py-3 text-neutral-400">{a.manufacturer ?? a.product?.manufacturer ?? '—'}</td>
                    <td className="px-4 py-3 text-neutral-400">{a.model ?? a.product?.model ?? '—'}</td>
                    <td className="px-4 py-3 text-neutral-400">{a.serialNumber ?? '—'}</td>
                    <td className="px-4 py-3 text-neutral-400">{a.tag}</td>
                    <td className="px-4 py-3 text-neutral-400">{a.batch?.batchNumber ?? '—'}</td>
                    <td className="px-4 py-3 text-neutral-400">{a.lot?.lotNumber ?? '—'}</td>
                    <td className="px-4 py-3 text-neutral-400">{date(a.soldAt)}</td>
                    <td className="px-4 py-3 text-neutral-400">{a.soldBy?.name ?? '—'}</td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        <ReturnControl
                          kind="asset"
                          id={a.id}
                          label={`${a.name} (${a.tag})`}
                          originalId={a.batch?.id ?? null}
                          originalLabel={a.batch?.batchNumber ?? null}
                          destinations={batchDests}
                        />
                      </td>
                    )}
                  </tr>
                ))}
                {soldAssets.length === 0 && (
                  <tr>
                    <td colSpan={isAdmin ? 10 : 9} className="px-4 py-8 text-center text-neutral-500">
                      No sold devices yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-300">
            Pallet goods{' '}
            <span className="text-neutral-500">
              · {soldPalletLines.reduce((s, l) => s + l.quantity, 0)} units
            </span>
          </h2>
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3">Qty</th>
                  <th className="px-4 py-3">Pallet</th>
                  <th className="px-4 py-3">Date sold</th>
                  <th className="px-4 py-3">Sold by</th>
                  {isAdmin && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {soldPalletLines.map((l) => (
                  <tr key={l.id} className="border-t border-neutral-800">
                    <td className="px-4 py-3 text-neutral-100">{l.variant}</td>
                    <td className="px-4 py-3 font-medium tabular-nums">{l.quantity}</td>
                    <td className="px-4 py-3 text-neutral-400">{l.palletNumber}</td>
                    <td className="px-4 py-3 text-neutral-400">{date(l.soldAt)}</td>
                    <td className="px-4 py-3 text-neutral-400">{l.soldBy?.name ?? '—'}</td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        <ReturnControl
                          kind="pallet-line"
                          id={l.id}
                          label={`${l.quantity} × ${l.variant}`}
                          originalId={l.palletId}
                          originalLabel={l.palletId ? l.palletNumber : null}
                          destinations={palletDests}
                        />
                      </td>
                    )}
                  </tr>
                ))}
                {soldPalletLines.length === 0 && (
                  <tr>
                    <td colSpan={isAdmin ? 6 : 5} className="px-4 py-8 text-center text-neutral-500">
                      No sold pallet goods yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
