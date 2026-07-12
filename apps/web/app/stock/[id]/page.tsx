import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import { deleteStockLine, type StockLine } from '@/lib/actions/stock';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { formatLabel } from '@/lib/asset-options';
import { StockStatusBadge } from '../stock-status-badge';
import { AdjustStock } from './adjust-form';

async function loadLine(id: string): Promise<StockLine> {
  try {
    return await apiFetch<StockLine>(`/stock/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export default async function StockDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [line, user] = await Promise.all([loadLine(id), getSessionUser()]);
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const canDelete = user?.role === 'admin';
  const movements = line.movements ?? [];

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <BackLink href="/stock" label="Back to Consumables" />
        <div className="mt-3 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{line.name}</h1>
            <p className="mt-1 text-sm text-neutral-400">
              {line.sku ? `SKU ${line.sku} · ` : ''}
              {line.category ?? 'Uncategorised'} · {line.location?.name ?? 'Unassigned'}
            </p>
          </div>
          {canDelete && (
            <form action={deleteStockLine.bind(null, line.id)}>
              <button
                type="submit"
                className="rounded-md border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
              >
                Delete
              </button>
            </form>
          )}
        </div>

        <div className="mt-6 grid gap-8 md:grid-cols-2">
          <section>
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
              <div
                className={
                  'text-3xl font-semibold ' +
                  (line.status === 'out_of_stock'
                    ? 'text-red-400'
                    : line.status === 'low_stock'
                      ? 'text-amber-400'
                      : '')
                }
              >
                {line.quantity}
              </div>
              <div className="mt-1 flex items-center gap-2 text-sm text-neutral-400">
                On hand <StockStatusBadge status={line.status} />
              </div>
            </div>
            {canManage && (
              <div className="mt-4">
                <h2 className="mb-2 text-sm font-medium text-neutral-400">Adjust stock</h2>
                <AdjustStock lineId={line.id} />
              </div>
            )}
          </section>

          <section>
            <h2 className="text-sm font-medium text-neutral-400">Movements ({movements.length})</h2>
            <ul className="mt-3 space-y-2">
              {movements.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between rounded-md border border-neutral-800 px-3 py-2 text-sm"
                >
                  <div>
                    <span
                      className={
                        'font-medium ' + (m.delta > 0 ? 'text-emerald-400' : 'text-red-400')
                      }
                    >
                      {m.delta > 0 ? '+' : ''}
                      {m.delta}
                    </span>
                    <span className="ml-2 text-neutral-400">{formatLabel(m.reason)}</span>
                    {m.note && <span className="ml-2 text-neutral-500">— {m.note}</span>}
                  </div>
                  <span className="text-xs text-neutral-600">
                    {new Date(m.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
              {movements.length === 0 && (
                <li className="text-sm text-neutral-500">No movements yet.</li>
              )}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
