import { apiFetch, getSessionUser } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';
import { LookupsManager } from './lookups-manager';
import type { LookupValue } from '@/lib/actions/lookups';

export default async function LookupsPage() {
  const user = await getSessionUser();
  const isAdmin = user?.role === 'admin';

  const all: LookupValue[] = isAdmin
    ? await apiFetch<LookupValue[]>('/lookups?includeInactive=true').catch(() => [])
    : [];

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <Breadcrumbs items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Lookups' }]} />
        <h1 className="mt-3 text-2xl font-semibold">Lookup values</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-400">
          The master dropdown lists used by pallet Layout 2 (and future forms). New values also
          get added automatically when someone types one during data entry. Disable a value to
          hide it from dropdowns without affecting records that already use it.
        </p>

        {isAdmin ? (
          <LookupsManager all={all} />
        ) : (
          <p className="mt-6 text-sm text-neutral-500">Managing lookup values is admin-only.</p>
        )}
      </div>
    </main>
  );
}
