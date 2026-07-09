import { getLocations } from '@/lib/data';
import { Nav } from '@/app/components/nav';
import { NewAssetForm } from './new-asset-form';

export default async function NewAssetPage() {
  const locations = await getLocations();

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <h1 className="text-2xl font-semibold">New Asset</h1>
        <NewAssetForm locations={locations} />
      </div>
    </main>
  );
}
