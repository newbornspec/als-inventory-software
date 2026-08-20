import { getLocations } from '@/lib/data';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { NewStockForm } from './new-stock-form';

export default async function NewStockPage() {
  const locations = await getLocations();

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <BackLink href="/stock" label="Back to Consumables" />
        <h1 className="mt-3 text-2xl font-semibold">New Consumable</h1>
        <NewStockForm locations={locations} />
      </main>
  </>
  );
}
