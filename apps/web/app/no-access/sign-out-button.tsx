'use client';

import { logout } from '@/lib/auth';

export function SignOutButton() {
  async function handleClick() {
    await logout();
    window.location.href = '/login';
  }

  return (
    <button
      onClick={handleClick}
      className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white"
    >
      Sign out
    </button>
  );
}
