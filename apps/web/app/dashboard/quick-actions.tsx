import Link from 'next/link';
import {
  ArrowLeftRight,
  Banknote,
  ClipboardCheck,
  Droplet,
  Grid3x3,
  PackagePlus,
  ScanLine,
  Zap,
  type LucideIcon,
} from 'lucide-react';

// The jobs a warehouse actually starts from a cold open, each pointing at a
// screen that exists.
//
// Transfer and Record sale were both absent until they were built; each is a
// real screen now, not a button pointing at something adjacent.
//
// Start stocktake is still missing on purpose: there is no stocktake or
// cycle-count in the system. The nearest real thing is reconciling a lot
// against its manifest, offered below under its own name. A button that goes
// somewhere unrelated is worse than no button — it costs a click and teaches
// people the dashboard lies.
const ACTIONS: {
  href: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  managerOnly?: boolean;
}[] = [
  { href: '/batches/new', label: 'New purchase lot', hint: 'Book in goods you have bought', icon: PackagePlus },
  { href: '/scan', label: 'Receive / scan', hint: 'Scan devices into a lot', icon: ScanLine },
  { href: '/assets/new', label: 'Add device', hint: 'One serialised unit by hand', icon: Zap },
  { href: '/stock/new', label: 'Add consumable', hint: 'Cables, keyboards, boxes', icon: Droplet },
  { href: '/pallets/new', label: 'New pallet', hint: 'Build a pallet for sale', icon: Grid3x3 },
  { href: '/transfer', label: 'Transfer stock', hint: 'Move items between locations', icon: ArrowLeftRight, managerOnly: true },
  { href: '/sell', label: 'Record a sale', hint: 'Sell a device in your hand', icon: Banknote, managerOnly: true },
  { href: '/batches', label: 'Reconcile a lot', hint: 'Check scanned against manifest', icon: ClipboardCheck },
];

export function QuickActions({ canManage }: { canManage: boolean }) {
  const actions = ACTIONS.filter((a) => !a.managerOnly || canManage);
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {actions.map(({ href, label, hint, icon: Icon }) => (
        <li key={href}>
          <Link
            href={href}
            className="flex h-full flex-col gap-1 rounded-lg border border-neutral-200 bg-white p-3 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
          >
            <Icon className="size-5 text-[#2b7fff]" aria-hidden="true" />
            <span className="mt-1 text-sm font-medium text-neutral-950">{label}</span>
            <span className="text-xs text-neutral-600">{hint}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
