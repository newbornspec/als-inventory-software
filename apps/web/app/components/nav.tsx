'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BarChart3,
  Box,
  Boxes,
  ChevronDown,
  ClipboardCheck,
  Cog,
  Droplet,
  Grid3x3,
  LayoutDashboard,
  Layers,
  LogOut,
  Menu,
  Package,
  Scan,
  Search,
  ShoppingCart,
  Users,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { logout } from '@/lib/auth';

// The navigation mirrors how the warehouse actually works rather than exposing
// every module as its own destination:
//
//   Dashboard → Inventory → Operations (things you do) → Stock (things you
//   manage) → Reports (things you analyse) → Administration (things you set up)
//
// Thirteen top-level links could not fit one row, so the header used to wrap
// onto a second line. Grouping fixes the cause; shrinking the type would only
// have hidden it.
//
// Each item still names the permission that opens it, and the nav shows
// exactly what the signed-in user holds. A GROUP disappears entirely when the
// user holds none of its items — never an empty dropdown. Hiding here is UX
// only: PermissionsGuard enforces the same rule on every API call, so a typed
// URL gets a 403, not data.
interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission: string;
  hint?: string;
}
interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}
type NavEntry = NavItem | NavGroup;

const isGroup = (e: NavEntry): e is NavGroup => 'items' in e;

const NAV: NavEntry[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard' },
  { href: '/inventory', label: 'Inventory', icon: Package, permission: 'inventory' },
  {
    label: 'Operations',
    icon: Wrench,
    items: [
      // Intake: booking in purchased goods and reconciling them against the
      // supplier manifest. The route stays /batches — the label was never
      // tied to it.
      {
        href: '/batches',
        label: 'Goods In',
        icon: Boxes,
        permission: 'goods_in',
        hint: 'Receive and reconcile incoming lots',
      },
      // The audit workspace: day-grouped audit events across all devices.
      // Deliberately its own section, not a renamed intake — the two
      // workflows differ and the grouping must not blur that.
      {
        href: '/audit',
        label: 'Audit',
        icon: ClipboardCheck,
        permission: 'amazon_audit',
        hint: 'Audit activity day by day',
      },
      {
        href: '/scan',
        label: 'Scan',
        icon: Scan,
        permission: 'scan',
        hint: 'Scan devices in from the floor',
      },
    ],
  },
  {
    label: 'Stock',
    icon: Layers,
    items: [
      {
        href: '/assets',
        label: 'Assets',
        icon: Zap,
        permission: 'assets',
        hint: 'The serialized device register',
      },
      {
        href: '/pallets',
        label: 'Pallets',
        icon: Grid3x3,
        permission: 'pallets',
        hint: 'Build and sell palletised stock',
      },
      {
        href: '/stock',
        label: 'Consumables',
        icon: Droplet,
        permission: 'consumables',
        hint: 'Cables, keyboards, packaging',
      },
      {
        href: '/sold',
        label: 'Sold',
        icon: ShoppingCart,
        permission: 'sold',
        hint: 'What has left the business',
      },
    ],
  },
  { href: '/reports', label: 'Reports', icon: BarChart3, permission: 'reports' },
  {
    label: 'Administration',
    icon: Cog,
    items: [
      {
        href: '/activity',
        label: 'Activity',
        icon: Activity,
        permission: 'activity',
        hint: 'Who did what, and when',
      },
      { href: '/users', label: 'Users', icon: Users, permission: 'users', hint: 'Accounts and permissions' },
      // Keyed on the ACTION rather than a module: the Lookups page is the
      // editing surface, and reading lookups needs no permission at all.
      {
        href: '/lookups',
        label: 'Lookups',
        icon: Search,
        permission: 'manage_lookups',
        hint: 'Manufacturers, models, locations',
      },
    ],
  },
];

export function Nav() {
  const pathname = usePathname();
  const [access, setAccess] = useState<{ role: string; permissions: string[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const groupButtons = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    // DB-fresh role + permissions (see /api/me). Until it resolves the row is
    // empty rather than a guess — links pop in once.
    fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((user) =>
        setAccess(user ? { role: user.role, permissions: user.permissions ?? [] } : null),
      )
      .catch(() => setAccess(null));
  }, []);

  // A route change closes both menus, or they would sit on top of the page you
  // just navigated to.
  useEffect(() => {
    setOpen(false);
    setOpenGroup(null);
  }, [pathname]);

  // Escape closes and hands focus back to the control that opened it, so a
  // keyboard user is never dropped at the top of the document (WCAG 2.4.3).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (openGroup) {
        const btn = groupButtons.current[openGroup];
        setOpenGroup(null);
        btn?.focus();
      } else if (open) {
        setOpen(false);
        toggleRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, openGroup]);

  // A click anywhere outside the bar dismisses an open dropdown — the expected
  // behaviour for a menu, and it keeps the panel from shadowing the page.
  useEffect(() => {
    if (!openGroup) return;
    function onPointer(e: MouseEvent) {
      if (!navRef.current?.contains(e.target as Node)) setOpenGroup(null);
    }
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [openGroup]);

  const allowed = (permission: string) =>
    access !== null && (access.role === 'admin' || access.permissions.includes(permission));

  // Exactly what this user holds. A group keeps only its permitted items, and
  // drops out completely when none remain.
  const entries: NavEntry[] = access
    ? NAV.map((e) => (isGroup(e) ? { ...e, items: e.items.filter((i) => allowed(i.permission)) } : e))
        .filter((e) => (isGroup(e) ? e.items.length > 0 : allowed(e.permission)))
    : [];

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const activeIn = (g: NavGroup) => g.items.find((i) => isActive(i.href));

  async function handleLogout() {
    await logout();
    // Full-page navigation so the app fully reloads (fresh bundle + cleared
    // session) rather than an in-app route change that keeps the old code.
    window.location.href = '/login';
  }

  const TOP_ACTIVE =
    'flex shrink-0 items-center gap-2 rounded-lg border-b-2 border-[#2b7fff] px-3 py-2 text-sm font-semibold text-neutral-950';
  const TOP_IDLE =
    'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900';
  const topClass = (active: boolean) => (active ? TOP_ACTIVE : TOP_IDLE);

  // Focus the first link when a dropdown is opened from the keyboard.
  function openWithFocus(label: string) {
    setOpenGroup(label);
    requestAnimationFrame(() => {
      navRef.current?.querySelector<HTMLElement>(`[data-panel="${label}"] a`)?.focus();
    });
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
            <span className="mt-1 hidden text-xs leading-4 text-neutral-600 xl:block">
              Warehouse operations
            </span>
          </div>
        </Link>

        {/* ONE row, always. flex-nowrap is the rule the old bar broke: with
            thirteen destinations it wrapped to a second line, which read as
            the app running out of space. Six entries fit comfortably, and
            below lg the whole thing becomes the drawer below. */}
        <nav
          ref={navRef}
          aria-label="Main"
          className="hidden min-w-0 flex-1 flex-nowrap items-center gap-1 lg:flex"
        >
          {entries.map((entry) => {
            if (!isGroup(entry)) {
              const { href, label, icon: Icon } = entry;
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={topClass(active)}
                >
                  <Icon
                    className={
                      // Decoration, not information: the label carries the
                      // meaning. Between lg and xl the six entries plus the
                      // logo and Log out do not fit one row, and dropping the
                      // glyphs buys that space without shrinking any type.
                      (active ? 'text-[#2b7fff] ' : '') + 'hidden size-4 xl:block'
                    }
                    aria-hidden="true"
                  />
                  <span>{label}</span>
                </Link>
              );
            }

            const { label, icon: Icon, items } = entry;
            const current = activeIn(entry);
            const expanded = openGroup === label;
            return (
              <div key={label} className="relative shrink-0">
                <button
                  ref={(el) => {
                    groupButtons.current[label] = el;
                  }}
                  type="button"
                  aria-expanded={expanded}
                  aria-haspopup="true"
                  aria-controls={`nav-${label}`}
                  onClick={() => setOpenGroup(expanded ? null : label)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      openWithFocus(label);
                    }
                  }}
                  className={topClass(!!current)}
                >
                  <Icon
                    className={(current ? 'text-[#2b7fff] ' : '') + 'hidden size-4 xl:block'}
                    aria-hidden="true"
                  />
                  <span>{label}</span>
                  {/* Where you are stays visible even though the page sits
                      inside a menu — the point of grouping is not to hide the
                      current location. */}
                  {current && (
                    // Shown from xl only. Its width depends on WHICH child is
                    // active ("Stock · Consumables" is far wider than
                    // "Stock"), so keeping it at every width would make
                    // whether the bar overflows depend on the page you happen
                    // to be on. Below xl the active underline still marks the
                    // group and the page's own breadcrumbs name the location.
                    <span className="hidden text-sm font-normal text-neutral-500 xl:inline">
                      · {current.label}
                    </span>
                  )}
                  <ChevronDown
                    className={expanded ? 'size-4 rotate-180 transition-transform' : 'size-4 transition-transform'}
                    aria-hidden="true"
                  />
                </button>

                <div
                  id={`nav-${label}`}
                  data-panel={label}
                  hidden={!expanded}
                  className="absolute left-0 top-full z-40 mt-2 w-72 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg"
                >
                  <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    {label}
                  </p>
                  {items.map(({ href, label: itemLabel, icon: ItemIcon, hint }) => {
                    const active = isActive(href);
                    return (
                      <Link
                        key={href}
                        href={href}
                        aria-current={active ? 'page' : undefined}
                        className={
                          'flex items-start gap-3 rounded-lg px-2 py-2 ' +
                          (active ? 'bg-blue-50' : 'hover:bg-neutral-50')
                        }
                      >
                        <ItemIcon
                          className={
                            'mt-0.5 size-4 shrink-0 ' + (active ? 'text-[#2b7fff]' : 'text-neutral-500')
                          }
                          aria-hidden="true"
                        />
                        <span className="min-w-0">
                          <span
                            className={
                              'block text-sm ' +
                              (active ? 'font-semibold text-neutral-950' : 'font-medium text-neutral-800')
                            }
                          >
                            {itemLabel}
                          </span>
                          {hint && (
                            <span className="block text-xs leading-4 text-neutral-500">{hint}</span>
                          )}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
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
            {open ? <X className="size-4" aria-hidden="true" /> : <Menu className="size-4" aria-hidden="true" />}
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

      {/* Below lg the same information architecture becomes a drawer: the
          groups are headed sections, not a flat list, so the mental model does
          not change with the screen size. Rendered-but-hidden rather than
          unmounted, so aria-controls always points at a real element. */}
      <nav
        id="main-menu"
        aria-label="Main"
        hidden={!open}
        className="mt-2 max-h-[70svh] overflow-y-auto border-t border-neutral-200 pt-2 lg:hidden"
      >
        {entries.map((entry) => {
          if (!isGroup(entry)) {
            const { href, label, icon: Icon } = entry;
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={topClass(active) + ' w-full'}
              >
                <Icon className={active ? 'size-4 text-[#2b7fff]' : 'size-4'} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            );
          }
          return (
            <div key={entry.label} className="mt-2 first:mt-0">
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                {entry.label}
              </p>
              {entry.items.map(({ href, label, icon: Icon }) => {
                const active = isActive(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={topClass(active) + ' w-full'}
                  >
                    <Icon className={active ? 'size-4 text-[#2b7fff]' : 'size-4'} aria-hidden="true" />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
    </header>
  );
}
