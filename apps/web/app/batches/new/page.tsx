import { getLocations } from '@/lib/data';
import { Nav } from '@/app/components/nav';
import { NewBatchForm } from './new-batch-form';

export default async function NewBatchPage() {
  const locations = await getLocations();

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <h1 className="text-2xl font-semibold">New Purchase Lot</h1>
        <NewBatchForm locations={locations} />
      </div>
    </main>
  );
}
