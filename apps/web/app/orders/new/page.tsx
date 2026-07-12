import { apiFetch } from '@/lib/api-server';
import type { Customer } from '@/lib/actions/customers';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { NewOrderForm } from './new-order-form';

export default async function NewOrderPage() {
  const customers = await apiFetch<Customer[]>('/customers');

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <BackLink href="/orders" label="Back to Sales" />
        <h1 className="mt-3 text-2xl font-semibold">New Sales Order</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Create the order, then add line items on the next screen.
        </p>
        <NewOrderForm customers={customers} />
      </div>
    </main>
  );
}
