import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { NewUserForm } from './new-user-form';

export default async function NewUserPage() {
  const session = await getSessionUser();
  if (session?.role !== 'admin') redirect('/dashboard');

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <BackLink href="/users" label="Back to Users" />
        <h1 className="mt-3 text-2xl font-semibold">New User</h1>
        <NewUserForm />
      </main>
  </>
  );
}
