import Link from 'next/link';

export interface Crumb {
  label: string;
  href?: string; // omitted on the current (last) page
}

// Drill-down trail shown at the top of hierarchy pages, e.g.
//   Dashboard / Lots / BATCH-000020 / Dell Latitude 3310
// The last item is the current page (not a link).
//
// A real <ol>, because that is what a breadcrumb is: an ordered path. Screen
// readers then announce "list, 4 items" and let you step through it, instead of
// reading one run-on line. The current page carries aria-current="page" so it is
// identifiable as the destination rather than just being a slightly darker grey,
// and the "/" separators are aria-hidden — otherwise every trail is read as
// "Dashboard slash Lots slash…".
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-x-1.5">
              {c.href && !last ? (
                <Link href={c.href} className="text-neutral-700 hover:text-neutral-950">
                  {c.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={last ? 'font-medium text-neutral-950' : 'text-neutral-700'}
                >
                  {c.label}
                </span>
              )}
              {!last && (
                <span aria-hidden="true" className="text-neutral-500">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
