import { getLocations } from '@/lib/data';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { NewAssetForm } from './new-asset-form';

export default async function NewAssetPage() {
  const locations = await getLocations();

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <BackLink href="/assets" label="Back to Assets" />
        <h1 className="mt-3 text-2xl font-semibold">New Asset</h1>
        <NewAssetForm locations={locations} />
      </div>
    </main>
  );
}
