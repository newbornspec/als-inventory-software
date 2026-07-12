import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { NewCustomerForm } from './new-customer-form';

export default function NewCustomerPage() {
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <BackLink href="/customers" label="Back to Customers" />
        <h1 className="mt-3 text-2xl font-semibold">New Customer</h1>
        <NewCustomerForm />
      </div>
    </main>
  );
}
