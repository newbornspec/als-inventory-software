import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import type { SalesOrder } from '@/lib/actions/sales';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';

export default async function OrdersPage() {
  const [orders, user] = await Promise.all([apiFetch<SalesOrder[]>('/orders'), getSessionUser()]);
  const canCreate = user?.role === 'admin' || user?.role === 'manager';

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Sales Orders</h1>
          {canCreate && (
            <Link
              href="/orders/new"
              className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
            >
              New Order
            </Link>
          )}
        </div>

        <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-4 py-3">Order #</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Lines</th>
                <th className="px-4 py-3">Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-neutral-800 hover:bg-neutral-900">
                  <td className="px-4 py-3">
                    <Link href={`/orders/${o.id}`} className="text-neutral-100 underline">
                      {o.orderNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-neutral-400">{o.customer?.name ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs">
                      {formatLabel(o.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-neutral-400">{o.lineCount}</td>
                  <td className="px-4 py-3 font-medium">{money(o.total)}</td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-neutral-500">
                    No orders yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
