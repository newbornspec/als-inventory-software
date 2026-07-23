import Link from 'next/link';
import { apiFetch, getSessionUser } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';

interface ActivityEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  createdAt: string;
  user: { id: string; name: string } | null;
}

// Where a given log entry links to, if anywhere.
function entityHref(e: ActivityEntry): string | null {
  if (!e.entityId) return null;
  if (e.entityType === 'batch') return `/batches/${e.entityId}`;
  if (e.entityType === 'asset') return `/assets/${e.entityId}`;
  return null;
}

export default async function ActivityPage() {
  const user = await getSessionUser();
  const canView = user?.role === 'admin' || user?.role === 'manager';

  const entries: ActivityEntry[] = canView
    ? await apiFetch<ActivityEntry[]>('/activity?limit=200').catch(() => [])
    : [];

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <Breadcrumbs items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Activity' }]} />
        <h1 className="mt-3 text-2xl font-semibold">Activity log</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Every meaningful action, newest first — who did what, and when.
        </p>

        {!canView ? (
          <p className="mt-6 text-sm text-neutral-500">
            You don’t have access to the activity log.
          </p>
        ) : entries.length === 0 ? (
          <p className="mt-6 text-sm text-neutral-500">No activity recorded yet.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const href = entityHref(e);
                  return (
                    <tr key={e.id} className="border-t border-neutral-800">
                      <td className="whitespace-nowrap px-4 py-2 text-neutral-400">
                        {new Date(e.createdAt).toLocaleString('en-GB')}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-neutral-200">
                        {e.user?.name ?? 'System'}
                      </td>
                      <td className="px-4 py-2 text-neutral-300">
                        {href ? (
                          <Link href={href} className="underline hover:text-neutral-100">
                            {e.summary}
                          </Link>
                        ) : (
                          e.summary
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
