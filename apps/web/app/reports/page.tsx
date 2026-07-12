import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { Asset } from '@/lib/actions/assets';
import { Nav } from '@/app/components/nav';
import { money } from '@/lib/money';

interface LotProfit {
  batchId: string;
  batchNumber: string;
  source: string | null;
  totalCost: number | null;
  units: number;
  unitsSold: number;
  revenue: number;
  costOfSold: number;
  profit: number;
  margin: number | null;
}

export default async function ReportsPage() {
  const user = await getSessionUser();
  const canSeeProfit = user?.role === 'admin' || user?.role === 'manager';

  const [assets, profit] = await Promise.all([
    apiFetch<Asset[]>('/assets'),
    canSeeProfit
      ? apiFetch<LotProfit[]>('/reports/profit')
      : Promise.resolve([] as LotProfit[]),
  ]);

  const byCategory = assets.reduce<Record<string, number>>((acc, a) => {
    acc[a.category] = (acc[a.category] ?? 0) + 1;
    return acc;
  }, {});

  const totals = profit.reduce(
    (acc, r) => {
      acc.revenue += r.revenue;
      acc.costOfSold += r.costOfSold;
      acc.profit += r.profit;
      return acc;
    },
    { revenue: 0, costOfSold: 0, profit: 0 },
  );

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
            Export assets CSV
          </a>
        </div>

        {canSeeProfit && (
          <section className="mt-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-neutral-400">
                Profit by purchase lot (realized on shipped units)
              </h2>
              <a href="/api/reports/profit-csv" className="text-sm text-neutral-300 underline">
                Export profit CSV
              </a>
            </div>

            <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-900 text-neutral-400">
                  <tr>
                    <th className="px-3 py-2">Lot</th>
                    <th className="px-3 py-2">Supplier</th>
                    <th className="px-3 py-2 text-right">Lot cost</th>
                    <th className="px-3 py-2 text-right">Sold / units</th>
                    <th className="px-3 py-2 text-right">Revenue</th>
                    <th className="px-3 py-2 text-right">Cost of sold</th>
                    <th className="px-3 py-2 text-right">Profit</th>
                    <th className="px-3 py-2 text-right">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {profit.map((r) => (
                    <tr key={r.batchId} className="border-t border-neutral-800">
                      <td className="px-3 py-2 text-neutral-200">{r.batchNumber}</td>
                      <td className="px-3 py-2 text-neutral-400">{r.source ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-neutral-400">
                        {r.totalCost != null ? money(r.totalCost) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-neutral-400">
                        {r.unitsSold} / {r.units}
                      </td>
                      <td className="px-3 py-2 text-right text-neutral-300">{money(r.revenue)}</td>
                      <td className="px-3 py-2 text-right text-neutral-400">
                        {money(r.costOfSold)}
                      </td>
                      <td
                        className={
                          'px-3 py-2 text-right font-medium ' +
                          (r.profit > 0
                            ? 'text-emerald-400'
                            : r.profit < 0
                              ? 'text-red-400'
                              : 'text-neutral-300')
                        }
                      >
                        {money(r.profit)}
                      </td>
                      <td className="px-3 py-2 text-right text-neutral-400">
                        {r.margin == null ? '—' : `${(r.margin * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                  {profit.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-6 text-center text-neutral-500">
                        No purchase lots yet.
                      </td>
                    </tr>
                  )}
                </tbody>
                {profit.length > 0 && (
                  <tfoot>
                    <tr className="border-t border-neutral-700 bg-neutral-900/60 font-medium">
                      <td className="px-3 py-2" colSpan={4}>
                        Total
                      </td>
                      <td className="px-3 py-2 text-right">{money(totals.revenue)}</td>
                      <td className="px-3 py-2 text-right text-neutral-400">
                        {money(totals.costOfSold)}
                      </td>
                      <td
                        className={
                          'px-3 py-2 text-right ' +
                          (totals.profit >= 0 ? 'text-emerald-400' : 'text-red-400')
                        }
                      >
                        {money(totals.profit)}
                      </td>
                      <td className="px-3 py-2" />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </section>
        )}

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
