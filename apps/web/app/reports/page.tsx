import { apiFetch } from '@/lib/api-server';
import type { Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';

export default async function ReportsPage() {
  const assets = await apiFetch<Asset[]>('/assets');

  const byCategory = assets.reduce<Record<string, number>>((acc, a) => {
    acc[a.category] = (acc[a.category] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Reports</h1>
          <a
            href="/api/reports/assets-csv"
            className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
          >
            Export CSV
          </a>
        </div>

        <div className="mt-8">
          <h2 className="text-sm font-medium text-neutral-400">Assets by category</h2>
          <div className="mt-3 overflow-hidden rounded-lg border border-neutral-800">
            <table className="w-full text-left text-sm">
              <tbody>
                {Object.entries(byCategory).map(([category, count]) => (
                  <tr key={category} className="border-t border-neutral-800 first:border-t-0">
                    <td className="px-4 py-2 text-neutral-300">{category}</td>
                    <td className="px-4 py-2 text-right text-neutral-500">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}
