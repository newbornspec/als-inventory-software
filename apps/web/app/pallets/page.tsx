import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Pallet } from '@/lib/actions/pallets';
import { Nav } from '@/app/components/nav';
import { NewPalletButton } from './new-pallet-button';
import { formatLabel } from '@/lib/asset-options';

function PalletTable({ pallets, shipped }: { pallets: Pallet[]; shipped: boolean }) {
  return (
    <div role="region" aria-label="Pallets" tabIndex={0} className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
      <table className="w-full text-left text-sm">
          <caption className="sr-only">Pallets with their status, location and unit counts</caption>
        <thead className="bg-neutral-50 text-neutral-500">
          <tr>
            <th scope="col" className="px-4 py-3">Pallet #</th>
            <th scope="col" className="px-4 py-3">Description</th>
            <th scope="col" className="px-4 py-3">Supplier</th>
            <th scope="col" className="px-4 py-3">{shipped ? 'Shipped on' : 'Status'}</th>
            <th scope="col" className="px-4 py-3">Total units</th>
            <th scope="col" className="px-4 py-3">Variants</th>
            <th scope="col" className="px-4 py-3">Location</th>
          </tr>
        </thead>
        <tbody>
          {pallets.map((p) => (
            <tr key={p.id} className="border-t border-neutral-200 hover:bg-white">
              <td className="px-4 py-3">
                <Link href={`/pallets/${p.id}`} className="text-neutral-950 underline">
                  {p.palletNumber}
                </Link>
              </td>
              <td className="px-4 py-3 text-neutral-500">{p.description ?? '—'}</td>
              <td className="px-4 py-3 text-neutral-500">{p.supplier || '—'}</td>
              <td className="px-4 py-3">
                {shipped ? (
                  <span className="text-neutral-500">
                    {p.shippedAt ? new Date(p.shippedAt).toLocaleDateString('en-GB') : '—'}
                  </span>
                ) : (
                  <span className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs">
                    {formatLabel(p.status)}
                  </span>
                )}
              </td>
              <td className="px-4 py-3 font-medium">{p.totalQuantity}</td>
              <td className="px-4 py-3 text-neutral-500">{p.lineCount}</td>
              <td className="px-4 py-3 text-neutral-500">{p.location?.name ?? '—'}</td>
            </tr>
          ))}
          {pallets.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-neutral-500">
                {shipped ? 'No shipped pallets yet.' : 'No active pallets.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default async function PalletsPage() {
  const [pallets, user] = await Promise.all([apiFetch<Pallet[]>('/pallets'), getSessionUser()]);
  const canCreate =
    user?.role === 'admin' || user?.role === 'manager' || user?.role === 'technician';

  const active = pallets.filter((p) => p.status !== 'shipped');
  const shipped = pallets.filter((p) => p.status === 'shipped');

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Pallets</h1>
          {canCreate && <NewPalletButton />}
        </div>

        <section className="mt-6">
          <h2 className="text-sm font-medium text-neutral-500">Active ({active.length})</h2>
          <PalletTable pallets={active} shipped={false} />
        </section>

        {shipped.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-medium text-neutral-500">Shipped ({shipped.length})</h2>
            <PalletTable pallets={shipped} shipped />
          </section>
        )}
      </main>
  </>
  );
}
