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
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Users</h1>
          <Link
            href="/users/new"
            className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white"
          >
            New User
          </Link>
        </div>

        <div role="region" aria-label="Users" tabIndex={0} className="mt-6 overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full text-left text-sm">
          <caption className="sr-only">User accounts and their roles</caption>
            <thead className="bg-neutral-50 text-neutral-500">
              <tr>
                <th scope="col" className="px-4 py-3">Name</th>
                <th scope="col" className="px-4 py-3">Email</th>
                <th scope="col" className="px-4 py-3">Role</th>
                <th scope="col" className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-neutral-200">
                  <td className="px-4 py-3">{user.name}</td>
                  <td className="px-4 py-3 text-neutral-500">{user.email}</td>
                  <td className="px-4 py-3">
                    <form action={updateUserRole.bind(null, user.id)} className="flex gap-2">
                      <select
                        name="role"
                        aria-label={`Role for ${user.name}`}
                        defaultValue={user.role}
                        disabled={user.id === session.userId}
                        className="field-inline px-2 py-1 text-sm disabled:opacity-50"
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
                          aria-label={`Save the role for ${user.name}`}
                          className="field-inline px-2 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
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
                          aria-label={`Delete the account for ${user.name}`}
                          className="text-xs text-red-700 hover:underline"
                        >
                          Delete
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-neutral-600">
                    No user accounts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
  </>
  );
}
