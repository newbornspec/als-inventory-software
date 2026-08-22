import { notFound, redirect } from 'next/navigation';
import { apiFetch, getSessionUser, ApiError } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import type { AppUser } from '@/lib/actions/users';
import { EditAccessForm } from './edit-access-form';

// The per-user Access screen: role plus the full ACCESS/ACTIONS grid.
// Reached from the Users list; the inline role dropdown there stays for quick
// promotions, this page is where deliberate per-user tailoring happens.
export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionUser();
  if (session?.role !== 'admin') redirect('/dashboard');

  const { id } = await params;
  const users = await apiFetch<AppUser[]>('/users').catch((err) => {
    if (err instanceof ApiError && err.status === 404) return [];
    throw err;
  });
  const user = users.find((u) => u.id === id);
  if (!user) notFound();

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <BackLink href="/users" label="Back to Users" />
        <h1 className="mt-3 text-2xl font-semibold">Access for {user.name}</h1>
        <p className="mt-1 text-sm text-neutral-500">{user.email}</p>
        <EditAccessForm user={user} isSelf={user.id === session.userId} />
      </main>
    </>
  );
}
