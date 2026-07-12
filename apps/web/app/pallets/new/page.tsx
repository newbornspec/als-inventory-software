import { getLocations } from '@/lib/data';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { NewPalletForm } from './new-pallet-form';

export default async function NewPalletPage() {
  const locations = await getLocations();

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <BackLink href="/pallets" label="Back to Pallets" />
        <h1 className="mt-3 text-2xl font-semibold">New Pallet</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Create the pallet, then add its contents by size/variant on the next screen.
        </p>
        <NewPalletForm locations={locations} />
      </div>
    </main>
  );
}
