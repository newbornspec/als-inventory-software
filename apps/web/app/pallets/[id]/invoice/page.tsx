import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiError, getSessionUser } from '@/lib/api-server';
import type { Pallet } from '@/lib/actions/pallets';
import { getNextInvoiceNumber } from '@/lib/actions/invoices';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { InvoiceForm } from './invoice-form';

export default async function GenerateInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  // Invoicing is a money document — same gate as the pallet report and costing
  // sheet. Redirecting rather than rendering a dead form: the API would refuse
  // the submit anyway, and finding that out after filling it in is worse.
  if (user?.role !== 'admin' && user?.role !== 'manager') {
    redirect(`/pallets/${id}`);
  }

  let pallet: Pallet;
  try {
    pallet = await apiFetch<Pallet>(`/pallets/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const nextNumber = await getNextInvoiceNumber();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <BackLink href={`/pallets/${id}`} label={`Back to ${pallet.palletNumber}`} />
        <h1 className="mt-3 text-2xl font-semibold">Generate invoice</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {pallet.palletNumber} · {pallet.totalQuantity} units
        </p>

        <InvoiceForm
          palletId={pallet.id}
          palletNumber={pallet.palletNumber}
          lines={pallet.lines ?? []}
          nextNumber={nextNumber}
          today={today}
        />
      </main>
  </>
  );
}
