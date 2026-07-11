import { getLocations } from '@/lib/data';
import { Nav } from '@/app/components/nav';
import { NewPalletForm } from './new-pallet-form';

export default async function NewPalletPage() {
  const locations = await getLocations();

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <h1 className="text-2xl font-semibold">New Pallet</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Create the pallet, then add its contents by size/variant on the next screen.
        </p>
        <NewPalletForm locations={locations} />
      </div>
    </main>
  );
}
