import { getLocations } from '@/lib/data';
import { Nav } from '@/app/components/nav';
import { NewStockForm } from './new-stock-form';

export default async function NewStockPage() {
  const locations = await getLocations();

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <h1 className="text-2xl font-semibold">New Consumable</h1>
        <NewStockForm locations={locations} />
      </div>
    </main>
  );
}
