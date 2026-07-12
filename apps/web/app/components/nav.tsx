'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { logout } from '@/lib/auth';

// Ordered along the warehouse workflow: receive a lot → scan devices into it →
// find any single device in the global Assets register.
const BASE_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/batches', label: 'Lots' },
  { href: '/scan', label: 'Scan' },
  { href: '/assets', label: 'Assets' },
  { href: '/pallets', label: 'Pallets' },
  { href: '/stock', label: 'Consumables' },
];

const MANAGER_LINKS = [
  { href: '/orders', label: 'Sales' },
  { href: '/customers', label: 'Customers' },
  { href: '/reports', label: 'Reports' },
];
const ADMIN_LINKS = [{ href: '/users', label: 'Users' }];

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [role, setRole] = useState<'admin' | 'manager' | 'technician' | null>(null);

  useEffect(() => {
    fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((user) => setRole(user?.role ?? null))
      .catch(() => setRole(null));
  }, []);

  const links = [
    ...BASE_LINKS,
    ...(role === 'admin' || role === 'manager' ? MANAGER_LINKS : []),
    ...(role === 'admin' ? ADMIN_LINKS : []),
  ];

  async function handleLogout() {
    await logout();
    router.push('/login');
    router.refresh();
  }

  return (
    <nav className="flex items-center justify-between border-b border-neutral-800 px-8 py-4">
      <div className="flex items-center gap-6">
        <span className="font-semibold text-neutral-100">Als Inventory</span>
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={
              pathname.startsWith(link.href)
                ? 'text-sm text-neutral-100'
                : 'text-sm text-neutral-500 hover:text-neutral-300'
            }
          >
            {link.label}
          </Link>
        ))}
      </div>
      <button onClick={handleLogout} className="text-sm text-neutral-500 hover:text-neutral-300">
        Log out
      </button>
    </nav>
  );
}
