import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionAccess } from '@/lib/api-server';
import { hasPermission, landingFor } from '@/lib/permissions';
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
  const user = await getSessionAccess();
  // Same gate as the Sold archive: selling is a money action, so this keys on
  // the 'sold' module — the same audience the old admin/manager check had.
  if (!hasPermission(user, 'sold')) {
    redirect(landingFor(user));
  }

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
        {/* BackLink, not Breadcrumbs: the app uses the trail on pages that sit
            in a hierarchy and a plain Back on task pages you came here to do
            one thing on. This is one of those. */}
        <BackLink href="/dashboard" label="Back to Dashboard" />
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Record a sale</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-600">
          For a device you have in front of you. To sell a whole lot or a pallet,
          open it and use the sell button there —{' '}
          <Link href="/batches" className="text-[#1a6ef5] hover:underline">
            Lots
          </Link>{' '}
          or{' '}
          <Link href="/pallets" className="text-[#1a6ef5] hover:underline">
            Pallets
          </Link>
          .
        </p>

        <div className="mt-4 max-w-2xl">
          <SellForm />
        </div>
        </div>
      </main>
    </>
  );
}
