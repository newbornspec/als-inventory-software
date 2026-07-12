import { apiFetch } from '@/lib/api-server';
import type { Customer } from '@/lib/actions/customers';
import { Nav } from '@/app/components/nav';
import { NewOrderForm } from './new-order-form';

export default async function NewOrderPage() {
  const customers = await apiFetch<Customer[]>('/customers');

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <h1 className="text-2xl font-semibold">New Sales Order</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Create the order, then add line items on the next screen.
        </p>
        <NewOrderForm customers={customers} />
      </div>
    </main>
  );
}
