import Link from 'next/link';

export interface Crumb {
  label: string;
  href?: string; // omitted on the current (last) page
}

// Drill-down trail shown at the top of hierarchy pages, e.g.
//   Dashboard / Lots / BATCH-000020 / Dell Latitude 3310
// The last item is the current page (not a link).
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-x-1.5">
            {c.href && !last ? (
              <Link href={c.href} className="text-neutral-400 hover:text-neutral-200">
                {c.label}
              </Link>
            ) : (
              <span className={last ? 'text-neutral-200' : 'text-neutral-400'}>{c.label}</span>
            )}
            {!last && <span className="text-neutral-600">/</span>}
          </span>
        );
      })}
    </nav>
  );
}
