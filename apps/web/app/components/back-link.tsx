import Link from 'next/link';

// Consistent "← Back to …" link used at the top of detail and create pages.
// The arrow is decoration: unhidden, every one of these is announced as
// "leftwards arrow Back to Pallets".
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-sm text-neutral-700 hover:text-neutral-950">
      <span aria-hidden="true">← </span>
      {label}
    </Link>
  );
}
