import { apiFetch, getSessionUser } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';
import { LookupsManager } from './lookups-manager';
import type { LookupValue } from '@/lib/lookups';

export default async function LookupsPage() {
  const user = await getSessionUser();
  const isAdmin = user?.role === 'admin';

  const all: LookupValue[] = isAdmin
    ? await apiFetch<LookupValue[]>('/lookups?includeInactive=true').catch(() => [])
    : [];

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
        <Breadcrumbs items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Lookups' }]} />
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Lookup values</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
          The master dropdown lists used by pallet Layout 2 (and future forms). New values also
          get added automatically when someone types one during data entry. Disable a value to
          hide it from dropdowns without affecting records that already use it.
        </p>

        {isAdmin ? (
          <LookupsManager all={all} />
        ) : (
          <p className="mt-4 rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
            Managing lookup values is admin-only.
          </p>
        )}
        </div>
      </main>
  </>
  );
}
