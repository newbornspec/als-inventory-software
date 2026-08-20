import { getLocations } from '@/lib/data';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { NewBatchForm } from './new-batch-form';

export default async function NewBatchPage() {
  const locations = await getLocations();

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <BackLink href="/batches" label="Back to Lots" />
        <h1 className="mt-3 text-2xl font-semibold">New Purchase Lot</h1>
        <NewBatchForm locations={locations} />
      </main>
  </>
  );
}
