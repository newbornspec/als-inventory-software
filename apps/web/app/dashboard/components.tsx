import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, Info } from 'lucide-react';

// Shared building blocks for the dashboard.
//
// Two rules run through all of them:
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
    <section aria-labelledby={id} className="mt-10 min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="text-base font-semibold text-neutral-950">
          {title}
        </h2>
        {action}
      </div>
      {description && <p className="mt-1 text-sm text-neutral-600">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

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
  // 'alert' adds a warning icon and a border — never colour on its own.
  emphasis?: 'alert' | 'critical';
}) {
  const border =
    emphasis === 'critical'
      ? 'border-red-300'
      : emphasis === 'alert'
        ? 'border-amber-300'
        : 'border-neutral-200';

  const body = (
    <>
      <div className="flex items-center gap-1.5">
        {emphasis && (
          <AlertTriangle
            className={emphasis === 'critical' ? 'size-4 text-red-700' : 'size-4 text-amber-700'}
            aria-hidden="true"
          />
        )}
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
      </div>
      <span className="mt-1 block text-sm text-neutral-600">{label}</span>
      {sub && <span className="mt-0.5 block text-xs text-neutral-600">{sub}</span>}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={`block rounded-lg border ${border} bg-white p-4 transition-colors hover:bg-neutral-50`}
      >
        {body}
      </Link>
    );
  }
  return <div className={`rounded-lg border ${border} bg-white p-4`}>{body}</div>;
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

export function SeverityBadge({ severity }: { severity: 'critical' | 'warning' }) {
  return severity === 'critical' ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800">
      <AlertTriangle className="size-3" aria-hidden="true" />
      Critical
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
      <Info className="size-3" aria-hidden="true" />
      Warning
    </span>
  );
}

export function OkBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
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
      className="inline-flex items-center gap-1 rounded font-medium text-blue-800 hover:underline"
    >
      {action}
      <span className="sr-only"> {context}</span>
      <ArrowRight className="size-3.5" aria-hidden="true" />
    </Link>
  );
}

// Tables live inside this: a scrollable region must be reachable by keyboard,
// which means it needs a tabindex and an accessible name (WCAG 2.1.1).
export function TableScroll({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="min-w-0 overflow-x-auto rounded-lg border border-neutral-200"
    >
      {children}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-600">{children}</p>;
}
