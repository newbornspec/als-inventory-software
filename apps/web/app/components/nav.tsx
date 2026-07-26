'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BarChart3,
  Box,
  Boxes,
  Droplet,
  Grid3x3,
  LayoutDashboard,
  LogOut,
  Package,
  Scan,
  Search,
  ShoppingCart,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { logout } from '@/lib/auth';

// Ordered along the warehouse workflow: receive a lot → scan devices into it →
// find any single device in the global Assets register.
const BASE_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory', icon: Package },
  { href: '/batches', label: 'Lots', icon: Boxes },
  { href: '/scan', label: 'Scan', icon: Scan },
  { href: '/assets', label: 'Assets', icon: Zap },
  { href: '/pallets', label: 'Pallets', icon: Grid3x3 },
  { href: '/stock', label: 'Consumables', icon: Droplet },
];

const MANAGER_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/sold', label: 'Sold', icon: ShoppingCart },
  { href: '/reports', label: 'Reports', icon: BarChart3 },
  { href: '/activity', label: 'Activity', icon: Activity },
];
const ADMIN_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/users', label: 'Users', icon: Users },
  { href: '/lookups', label: 'Lookups', icon: Search },
];

export function Nav() {
  const pathname = usePathname();
  const [role, setRole] = useState<'admin' | 'manager' | 'technician' | null>(null);

  useEffect(() => {
    fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((user) => setRole(user?.role ?? null))
      .catch(() => setRole(null));
  }, []);

  // Role gating is deliberate: technicians never see Sold/Reports/Activity, and
  // only admins see Users/Lookups.
  const links = [
    ...BASE_LINKS,
    ...(role === 'admin' || role === 'manager' ? MANAGER_LINKS : []),
    ...(role === 'admin' ? ADMIN_LINKS : []),
  ];

  async function handleLogout() {
    await logout();
    // Full-page navigation so the app fully reloads (fresh bundle + cleared
    // session), rather than an in-app route change that keeps the old code.
    window.location.href = '/login';
  }

  return (
    <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white/95 px-8 py-4 backdrop-blur-sm">
      <div className="flex items-center gap-6">
        <Link href="/dashboard" className="flex shrink-0 items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-[#2b7fff] text-white shadow-sm shadow-blue-500/15">
            <Box className="size-5" />
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-[15px] font-semibold tracking-tight text-neutral-950">
              ALS Inventory
            </span>
            <span className="mt-1 text-xs leading-4 text-neutral-500">Warehouse operations</span>
          </div>
        </Link>

        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'flex shrink-0 items-center gap-2 border-b-2 border-[#2b7fff] px-3 py-2 text-sm font-semibold text-neutral-950'
                    : 'flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
                }
              >
                <Icon className={active ? 'size-4 text-[#2b7fff]' : 'size-4'} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <button
          onClick={handleLogout}
          className="flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
        >
          <LogOut className="size-4" />
          Log out
        </button>
      </div>
    </header>
  );
}
