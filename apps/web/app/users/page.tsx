import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/api-server';
import { apiFetch } from '@/lib/api-server';
import { deleteUser, updateUserRole, type AppUser } from '@/lib/actions/users';
import { Nav } from '@/app/components/nav';

const ROLES = ['admin', 'manager', 'technician'];

export default async function UsersPage() {
  const session = await getSessionUser();
  if (session?.role !== 'admin') redirect('/dashboard');

  const users = await apiFetch<AppUser[]>('/users');

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <Nav />
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Users</h1>
          <Link
            href="/users/new"
            className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
          >
            New User
          </Link>
        </div>

        <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-neutral-800">
                  <td className="px-4 py-3">{user.name}</td>
                  <td className="px-4 py-3 text-neutral-400">{user.email}</td>
                  <td className="px-4 py-3">
                    <form action={updateUserRole.bind(null, user.id)} className="flex gap-2">
                      <select
                        name="role"
                        defaultValue={user.role}
                        disabled={user.id === session.userId}
                        className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm disabled:opacity-50"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      {user.id !== session.userId && (
                        <button
                          type="submit"
                          className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300"
                        >
                          Save
                        </button>
                      )}
                    </form>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {user.id !== session.userId && (
                      <form action={deleteUser.bind(null, user.id)}>
                        <button
                          type="submit"
                          className="text-xs text-red-400 hover:underline"
                        >
                          Delete
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
