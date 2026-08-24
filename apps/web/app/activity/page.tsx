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

// The API takes a limit and caps it at 500; it has no offset, so this is the
// most history the page can ask for in one request. Fetching the full 500 and
// paging it here beats fetching 200 and rendering every one of them: more of
// the log is reachable AND the page is a fraction of the height.
const FETCH_LIMIT = 500;
const PAGE_SIZE = 50;

const TH =
  'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500';
const TD = 'px-4 py-2.5 text-left text-sm';

// Where a given log entry links to, if anywhere.
function entityHref(e: ActivityEntry): string | null {
  if (!e.entityId) return null;
  if (e.entityType === 'batch') return `/batches/${e.entityId}`;
  if (e.entityType === 'asset') return `/assets/${e.entityId}`;
  return null;
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: rawPage } = await searchParams;
  const user = await getSessionUser();
  const canView = user?.role === 'admin' || user?.role === 'manager';

  const entries: ActivityEntry[] = canView
    ? await apiFetch<ActivityEntry[]>(`/activity?limit=${FETCH_LIMIT}`).catch(() => [])
    : [];

  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  // Clamped rather than 404'd: a bookmarked page number goes stale as the log
  // grows, and that is normal rather than an error.
  const page = Math.min(pageCount, Math.max(1, Number(rawPage) || 1));
  const start = (page - 1) * PAGE_SIZE;
  const rows = entries.slice(start, start + PAGE_SIZE);

  // Getting exactly the limit back means the log is longer than this. We cannot
  // say HOW much longer — the endpoint returns no total — so the page says what
  // it knows and no more. An audit log that silently stops at an arbitrary
  // point, with nothing on screen to say so, is the one place a quiet cap is
  // least acceptable: a reader checking who did what would believe they had
  // seen everything.
  const atCap = entries.length === FETCH_LIMIT;

  const N = (n: number) => n.toLocaleString('en-GB');

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
          <Breadcrumbs items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Activity' }]} />
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Activity log</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
            Every meaningful action, newest first — who did what, and when.
          </p>

          {!canView ? (
            <p className="mt-4 rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
              You don&rsquo;t have access to the activity log.
            </p>
          ) : entries.length === 0 ? (
            <p className="mt-4 rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
              No activity recorded yet.
            </p>
          ) : (
            <>
              <div
                role="region"
                aria-label="Activity log"
                tabIndex={0}
                className="relative mt-4 overflow-x-auto rounded-xl border border-neutral-200 bg-white"
              >
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    System activity: what was done, by whom and when
                  </caption>
                  <thead className="bg-neutral-50">
                    <tr>
                      <th scope="col" className={TH}>When</th>
                      <th scope="col" className={TH}>User</th>
                      <th scope="col" className={TH}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => {
                      const href = entityHref(e);
                      return (
                        <tr key={e.id} className="border-t border-neutral-200">
                          {/* The timestamp is what identifies the row, so it is
                              the row header — a screen reader then announces it
                              with the user and action rather than reading three
                              unattached cells. */}
                          <th
                            scope="row"
                            className={`${TD} whitespace-nowrap font-normal text-neutral-600 tabular-nums`}
                          >
                            {new Date(e.createdAt).toLocaleString('en-GB')}
                          </th>
                          <td className={`${TD} whitespace-nowrap text-neutral-900`}>
                            {e.user?.name ?? 'System'}
                          </td>
                          <td className={`${TD} text-neutral-800`}>
                            {href ? (
                              <Link href={href} className="text-[#1a6ef5] hover:underline">
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

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-neutral-600">
                  Showing{' '}
                  <span className="font-medium text-neutral-900 tabular-nums">
                    {N(start + 1)}–{N(Math.min(start + PAGE_SIZE, entries.length))}
                  </span>{' '}
                  of{' '}
                  <span className="font-medium text-neutral-900 tabular-nums">
                    {N(entries.length)}
                  </span>{' '}
                  {entries.length === 1 ? 'entry' : 'entries'}
                  {atCap && (
                    <>
                      {' · '}
                      <span className="text-neutral-700">
                        this is the newest {N(FETCH_LIMIT)}; older activity is not listed
                      </span>
                    </>
                  )}
                </p>
                {pageCount > 1 && (
                  <nav aria-label="Pagination" className="flex items-center gap-2">
                    <PageLink to={page - 1} disabled={page === 1} label="Previous" />
                    <span className="text-xs text-neutral-600 tabular-nums">
                      Page {N(page)} of {N(pageCount)}
                    </span>
                    <PageLink to={page + 1} disabled={page === pageCount} label="Next" />
                  </nav>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}

// A real link, so a page of the log can be bookmarked and shared. The dead end
// renders as a span: a disabled anchor is still focusable and still announced,
// which is worse than not offering it.
function PageLink({ to, disabled, label }: { to: number; disabled: boolean; label: string }) {
  const base =
    'rounded-md border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors';
  if (disabled) {
    return (
      <span aria-disabled="true" className={`${base} border-neutral-200 bg-white text-neutral-400`}>
        {label}
      </span>
    );
  }
  return (
    <Link
      href={`/activity?page=${to}`}
      aria-label={`${label} page`}
      className={`${base} border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-50`}
    >
      {label}
    </Link>
  );
}
