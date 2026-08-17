import { getLocations } from '@/lib/data';
import { getNextPalletNumber } from '@/lib/actions/pallets';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { NewPalletForm } from './new-pallet-form';

export default async function NewPalletPage() {
  // Prefill the number field with the next in sequence. It is a suggestion —
  // the operator types whatever is written on the pallet.
  const [locations, suggestedNumber] = await Promise.all([
    getLocations(),
    getNextPalletNumber(),
  ]);

  return (
    <main className="min-h-screen bg-white text-neutral-950">
      <Nav />
      <div className="p-8">
        <BackLink href="/pallets" label="Back to Pallets" />
        <h1 className="mt-3 text-2xl font-semibold">New Pallet</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Create the pallet, then add its contents item by item on the next screen.
        </p>
        <NewPalletForm locations={locations} suggestedNumber={suggestedNumber} />
      </div>
    </main>
  );
}
