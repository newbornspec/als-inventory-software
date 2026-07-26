import Link from 'next/link';

// Consistent "← Back to …" link used at the top of detail and create pages.
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-sm text-neutral-500 hover:text-neutral-900">
      ← {label}
    </Link>
  );
}
