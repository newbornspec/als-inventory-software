import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/api-server';
import { Nav } from '@/app/components/nav';
import { NewUserForm } from './new-user-form';

export default async function NewUserPage() {
  const session = await getSessionUser();
  if (session?.role !== 'admin') redirect('/dashboard');

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <h1 className="text-2xl font-semibold">New User</h1>
        <NewUserForm />
      </div>
    </main>
  );
}
