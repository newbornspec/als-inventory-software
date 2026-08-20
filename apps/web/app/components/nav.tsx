'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BarChart3,
  Box,
  ClipboardCheck,
  Droplet,
  Grid3x3,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Scan,
  Search,
  ShoppingCart,
  Users,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { logout } from '@/lib/auth';

// Ordered along the warehouse workflow: receive a lot → scan devices into it →
// find any single device in the global Assets register.
const BASE_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory', icon: Package },
  // Labelled "Audit" while the route stays /batches. The label was already
  // decoupled from the route ("Lots" over /batches), so this changes nothing
  // structural — no bookmark breaks and no link rewrites — and the section is
  // being developed into the audit workspace next.
  { href: '/batches', label: 'Audit', icon: ClipboardCheck },
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
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((user) => setRole(user?.role ?? null))
      .catch(() => setRole(null));
  }, []);

  // Route change closes the small-screen menu, or it would stay open on top of
  // the page you just navigated to.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape closes and hands focus back to the button that opened it, so a
  // keyboard user is never dropped at the top of the document (WCAG 2.4.3).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

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

  function linkClass(active: boolean) {
    return active
      ? 'flex items-center gap-2 rounded-lg border-b-2 border-[#2b7fff] px-3 py-2 text-sm font-semibold text-neutral-950'
      : 'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900';
  }

  return (
    <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur-sm sm:px-8 sm:py-4">
      <div className="flex items-center gap-4 lg:gap-6">
        <Link href="/dashboard" className="flex shrink-0 items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-[#1a6ef5] text-white shadow-sm shadow-blue-500/15">
            <Box className="size-5" aria-hidden="true" />
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-[15px] font-semibold tracking-tight text-neutral-950">
              ALS Inventory
            </span>
            {/* Dropped below lg: it is decoration, and it was part of what
                pushed the link row into a horizontal scroll. */}
            <span className="mt-1 hidden text-xs leading-4 text-neutral-600 lg:block">
              Warehouse operations
            </span>
          </div>
        </Link>

        {/* The links used to live in one overflow-x-auto row of shrink-0 items,
            so on a laptop — and on any desktop at 200% zoom — the only way to
            reach Reports or Users was to scroll the header sideways, with no
            visible affordance that there was anything to scroll to. Now the row
            WRAPS on wide screens (nothing is ever off-screen) and collapses
            into a disclosure menu below lg. */}
        <nav aria-label="Main" className="hidden flex-1 flex-wrap items-center gap-1 lg:flex">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={linkClass(active)}
              >
                <Icon
                  className={active ? 'size-4 text-[#2b7fff]' : 'size-4'}
                  aria-hidden="true"
                />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            ref={toggleRef}
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="main-menu"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 lg:hidden"
          >
            {open ? (
              <X className="size-4" aria-hidden="true" />
            ) : (
              <Menu className="size-4" aria-hidden="true" />
            )}
            {open ? 'Close' : 'Menu'}
          </button>

          <button
            onClick={handleLogout}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 sm:px-4"
          >
            <LogOut className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Log out</span>
            <span className="sr-only sm:hidden">Log out</span>
          </button>
        </div>
      </div>

      {/* Rendered but hidden rather than unmounted, so aria-controls always
          points at a real element. */}
      <nav
        id="main-menu"
        aria-label="Main"
        hidden={!open}
        className="mt-2 grid max-h-[70svh] gap-1 overflow-y-auto border-t border-neutral-200 pt-2 lg:hidden"
      >
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={linkClass(active)}
            >
              <Icon className={active ? 'size-4 text-[#2b7fff]' : 'size-4'} aria-hidden="true" />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
