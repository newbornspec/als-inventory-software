import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { SellForm } from './sell-form';

// The way in to selling. Every other sell path starts from something you have
// already opened — a device, a lot, a pallet line — which is the wrong shape
// when the device is in your hand and you have its tag.
//
// No new API: this resolves a device then calls the same POST /assets/:id/sell
// that the device page has always used.
export default async function SellPage() {
  const user = await getSessionUser();
  // Same gate as the Sold archive: selling is a money action.
  if (user?.role !== 'admin' && user?.role !== 'manager') {
    redirect('/dashboard');
  }

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <BackLink href="/dashboard" label="Back to Dashboard" />
        <h1 className="mt-3 text-2xl font-semibold">Record a sale</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-600">
          For a device you have in front of you. To sell a whole lot or a pallet,
          open it and use the sell button there —{' '}
          <Link href="/batches" className="text-blue-800 underline">
            Lots
          </Link>{' '}
          or{' '}
          <Link href="/pallets" className="text-blue-800 underline">
            Pallets
          </Link>
          .
        </p>

        <div className="mt-8">
          <SellForm />
        </div>
      </main>
    </>
  );
}
