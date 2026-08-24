import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, Info } from 'lucide-react';

// Shared building blocks for the dashboard.
//
// The presentation matches the rest of the redesigned app — bordered cards on a
// tinted page, small uppercase section headings, hairline-separated metric
// cells, and pills that always print their state in words.
//
// Two rules run through all of them and must survive any restyle:
//   * meaning is never carried by colour alone (WCAG 1.4.1) — every state also
//     carries a word and an icon, so "5 low stock" reads the same to someone
//     who cannot see the amber;
//   * every bar is decoration. The number it depicts is always present as text
//     in the same row, so nothing is available only to people who can see the
//     chart (WCAG 1.1.1).

export function Section({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="mt-4 min-w-0 overflow-hidden rounded-xl border border-neutral-200 bg-white"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-200 px-4 py-3">
        <div className="min-w-0">
          <h2
            id={id}
            className="text-xs font-semibold uppercase tracking-wide text-neutral-900"
          >
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-neutral-600">{description}</p>}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

// A metric cell. Sits inside MetricGrid, which draws the hairlines — a cell
// carries no border of its own, so eight of them read as one instrument panel
// rather than eight competing boxes.
export function Tile({
  label,
  value,
  sub,
  href,
  emphasis,
}: {
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
  // 'alert'/'critical' add a warning icon and tint the figure — never colour on
  // its own: the label already names what the number is.
  emphasis?: 'alert' | 'critical';
}) {
  const tone =
    emphasis === 'critical'
      ? 'text-red-700'
      : emphasis === 'alert'
        ? 'text-amber-700'
        : 'text-neutral-950';

  const body = (
    <>
      <div className="flex items-center gap-1.5">
        {emphasis && (
          <AlertTriangle
            className={emphasis === 'critical' ? 'size-4 text-red-700' : 'size-4 text-amber-700'}
            aria-hidden="true"
          />
        )}
        <span className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</span>
      </div>
      <span className="mt-1 block text-[11px] uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      {sub && <span className="mt-0.5 block text-xs text-neutral-600">{sub}</span>}
    </>
  );

  if (href) {
    return (
      <Link href={href} className="block bg-white p-4 transition-colors hover:bg-neutral-50">
        {body}
      </Link>
    );
  }
  return <div className="bg-white p-4">{body}</div>;
}

// gap-px over a grey ground draws the rules between cells. Grid-aware, unlike
// divide-x/border-b, which are DOM-ordered and leave gaps at the wrap points.
export function MetricGrid({ cols = 4, children }: { cols?: 2 | 4; children: React.ReactNode }) {
  return (
    <div
      className={
        'grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-neutral-200 bg-neutral-200 ' +
        (cols === 4 ? 'sm:grid-cols-4' : '')
      }
    >
      {children}
    </div>
  );
}

// A bar that is purely decorative: the figure it represents is always rendered
// as text beside it.
export function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <span aria-hidden="true" className="block h-2 w-full overflow-hidden rounded-full bg-neutral-100">
      <span className="block h-full rounded-full bg-[#1a6ef5]" style={{ width: `${pct}%` }} />
    </span>
  );
}

const PILL = 'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide';

export function SeverityBadge({ severity }: { severity: 'critical' | 'warning' }) {
  return severity === 'critical' ? (
    <span className={`${PILL} bg-red-50 text-red-700`}>
      <AlertTriangle className="size-3" aria-hidden="true" />
      Critical
    </span>
  ) : (
    <span className={`${PILL} bg-amber-50 text-amber-800`}>
      <Info className="size-3" aria-hidden="true" />
      Warning
    </span>
  );
}

export function OkBadge() {
  return (
    <span className={`${PILL} bg-emerald-50 text-emerald-700`}>
      <CheckCircle2 className="size-3" aria-hidden="true" />
      Clear
    </span>
  );
}

// "View →" on its own is meaningless out of context, so every one of these
// carries the row's subject in visually-hidden text (WCAG 2.4.4).
export function RowLink({
  href,
  action,
  context,
}: {
  href: string;
  action: string;
  context: string;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded text-sm font-medium text-[#1a6ef5] hover:underline"
    >
      {action}
      <span className="sr-only"> {context}</span>
      <ArrowRight className="size-3.5" aria-hidden="true" />
    </Link>
  );
}

// Tables live inside this: a scrollable region must be reachable by keyboard,
// which means it needs a tabindex and an accessible name (WCAG 2.1.1).
//
// `relative` is load-bearing. The tables are wider than a phone, and they carry
// sr-only captions and link context — which Tailwind implements as
// position:absolute. Without a positioned ancestor those resolve against the
// initial containing block, so they sit at the table's *unscrolled* width, out
// past the viewport, and overflow:hidden further up cannot clip them: the whole
// page then scrolls sideways on mobile.
export function TableScroll({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="relative min-w-0 overflow-x-auto rounded-lg border border-neutral-200"
    >
      {children}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-neutral-600">{children}</p>;
}
