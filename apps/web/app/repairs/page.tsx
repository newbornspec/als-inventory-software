import Link from 'next/link';
import { apiFetch } from '@/lib/api-server';
import type { RepairLog } from '@/lib/actions/repairs';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';

// Every unfinished repair in the warehouse. Repairs were previously reachable
// only from a device you already had open, so the dashboard could say "4 open
// repairs" but had nowhere to send you — you had to know which four devices.
// This is that list.
interface OpenRepair extends RepairLog {
  asset?: {
    id: string;
    tag: string;
    name: string;
    location?: { id: string; name: string } | null;
  } | null;
}

export default async function RepairsPage() {
  const repairs = await apiFetch<OpenRepair[]>('/repairs');

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <h1 className="text-2xl font-semibold">Open repairs</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Repair jobs logged but not yet finished, newest first. Completed and written-off jobs stay
          on the device&rsquo;s own page.
        </p>

        {repairs.length === 0 ? (
          <p className="mt-6 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">
            No repairs are outstanding.
          </p>
        ) : (
          <div
            role="region"
            aria-label="Open repairs"
            tabIndex={0}
            className="mt-6 overflow-x-auto rounded-lg border border-neutral-200"
          >
            <table className="w-full min-w-[48rem] text-left text-sm">
              <caption className="sr-only">
                Outstanding repair jobs with the device, fault, parts, cost, status and who logged it
              </caption>
              <thead className="bg-neutral-50 text-neutral-600">
                <tr>
                  <th scope="col" className="px-4 py-3">Device</th>
                  <th scope="col" className="px-4 py-3">Location</th>
                  <th scope="col" className="px-4 py-3">Work / fault</th>
                  <th scope="col" className="px-4 py-3">Parts</th>
                  <th scope="col" className="px-4 py-3">Cost</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">Logged</th>
                </tr>
              </thead>
              <tbody>
                {repairs.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-200">
                    <th scope="row" className="px-4 py-3 font-normal">
                      <Link href={`/assets/${r.assetId}`} className="text-blue-800 underline">
                        {r.asset?.tag ?? 'Device'}
                      </Link>
                      {r.asset?.name && (
                        <span className="block text-xs text-neutral-600">{r.asset.name}</span>
                      )}
                    </th>
                    <td className="px-4 py-3 text-neutral-600">
                      {r.asset?.location?.name ?? 'No location set'}
                    </td>
                    <td className="px-4 py-3">{r.description}</td>
                    <td className="px-4 py-3 text-neutral-600">{r.partsUsed ?? '—'}</td>
                    <td className="px-4 py-3 tabular-nums">{money(r.cost)}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                        {formatLabel(r.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-600">
                      <time dateTime={r.createdAt}>
                        {new Date(r.createdAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                          timeZone: 'UTC',
                        })}
                      </time>
                      {r.performedBy?.name && (
                        <span className="block text-xs">{r.performedBy.name}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
  </>
  );
}
