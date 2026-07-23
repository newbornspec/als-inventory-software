import { getLocations } from '@/lib/data';
import { apiFetch } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { SpecPalletForm } from './spec-form';
import type { LookupValue } from '@/lib/actions/lookups';

export default async function NewSpecPalletPage() {
  const [locations, lookups] = await Promise.all([
    getLocations(),
    apiFetch<LookupValue[]>('/lookups').catch(() => [] as LookupValue[]),
  ]);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <BackLink href="/pallets" label="Back to Pallets" />
        <h1 className="mt-3 text-2xl font-semibold">New Pallet — Specification Table</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-400">
          Enter each hardware specification in its own column. Each row is a spec group; Quantity is
          how many machines share it. Start typing to search — pick an existing value or type a new
          one.
        </p>
        <SpecPalletForm locations={locations} lookups={lookups} />
      </div>
    </main>
  );
}
