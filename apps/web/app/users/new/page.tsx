import { redirect } from 'next/navigation';
import { getSessionAccess } from '@/lib/api-server';
import { hasPermission, landingFor } from '@/lib/permissions';
import { Nav } from '@/app/components/nav';
import { BackLink } from '@/app/components/back-link';
import { NewUserForm } from './new-user-form';

export default async function NewUserPage() {
  // Same rule as the API's users controller: the 'users' permission.
  const access = await getSessionAccess();
  if (!access || !hasPermission(access, 'users')) redirect(landingFor(access));

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
