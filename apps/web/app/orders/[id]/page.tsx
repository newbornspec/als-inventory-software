import { notFound } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import { deleteOrder, type SalesOrder } from '@/lib/actions/sales';
import { Nav } from '@/app/components/nav';
import { formatLabel } from '@/lib/asset-options';
import { money } from '@/lib/money';
import { OrderStatusSelect } from './status-select';
import { OrderLines } from './order-lines';

async function loadOrder(id: string): Promise<SalesOrder> {
  try {
    return await apiFetch<SalesOrder>(`/orders/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [order, user] = await Promise.all([loadOrder(id), getSessionUser()]);
  const canManage = user?.role === 'admin' || user?.role === 'manager';
  const canDelete = user?.role === 'admin';

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{order.orderNumber}</h1>
            <p className="mt-1 text-sm text-neutral-400">
              {order.customer?.name ?? 'No customer'}
              {order.orderRef ? ` · Ref ${order.orderRef}` : ''}
            </p>
          </div>
          {canDelete && (
            <form action={deleteOrder.bind(null, order.id)}>
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
            {canManage ? (
              <OrderStatusSelect orderId={order.id} status={order.status} />
            ) : (
              <div className="text-2xl font-semibold">{formatLabel(order.status)}</div>
            )}
            <div className="mt-1 text-sm text-neutral-400">Status</div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="text-2xl font-semibold">{order.lineCount}</div>
            <div className="mt-1 text-sm text-neutral-400">Line items</div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="text-2xl font-semibold">{money(order.total)}</div>
            <div className="mt-1 text-sm text-neutral-400">Order total</div>
          </div>
        </div>

        <section className="mt-8 max-w-3xl">
          <h2 className="text-sm font-medium text-neutral-400">Line items</h2>
          <OrderLines orderId={order.id} lines={order.lines ?? []} canManage={canManage} />
        </section>
      </div>
    </main>
  );
}
