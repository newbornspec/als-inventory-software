import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiFetch, getSessionAccess } from '@/lib/api-server';
import { hasPermission, landingFor } from '@/lib/permissions';
import { updateUserRole, type AppUser } from '@/lib/actions/users';
import { formatLabel } from '@/lib/asset-options';
import { Nav } from '@/app/components/nav';
import { DeleteUserButton } from './delete-user-button';

const ROLES = ['admin', 'manager', 'technician'];

const TH =
  'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500';
const TD = 'px-4 py-3 text-left text-sm';

export default async function UsersPage() {
  // Same rule as the API's users controller: the 'users' permission.
  const session = await getSessionAccess();
  if (!session || !hasPermission(session, 'users')) redirect(landingFor(session));

  const users = await apiFetch<AppUser[]>('/users');

  return (
    <>
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-screen bg-neutral-50 text-neutral-950 px-4 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto max-w-[90rem]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600">
              Changing a role here resets that user&rsquo;s access to the role&rsquo;s standard
              set — open Access to tailor what an individual can see and do.
            </p>
          </div>
          <Link
            href="/users/new"
            className="shrink-0 rounded-md bg-[#1a6ef5] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white hover:bg-blue-600"
          >
            New user
          </Link>
        </div>

        <div
          role="region"
          aria-label="Users"
          tabIndex={0}
          // `relative` is load-bearing. The Actions column's sr-only label sits
          // at the far right of a table wider than a phone, and Tailwind
          // implements sr-only as position:absolute — with no positioned
          // ancestor it resolves against the initial containing block, lands
          // past the viewport, and scrolls the whole page sideways. Same fix as
          // Dashboard, Inventory and Pallets; measured 196px before it.
          className="relative mt-4 overflow-x-auto rounded-xl border border-neutral-200 bg-white"
        >
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">User accounts and their roles</caption>
            <thead className="bg-neutral-50">
              <tr>
                <th scope="col" className={TH}>Name</th>
                <th scope="col" className={TH}>Email</th>
                <th scope="col" className={TH}>Role</th>
                <th scope="col" className={`${TH} text-right`}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr
                  key={user.id}
                  className="border-t border-neutral-200 transition-colors hover:bg-neutral-50"
                >
                  <th scope="row" className={`${TD} font-medium`}>
                    {user.name}
                    {/* Explicit space: JSX drops the newline between these two
                        expressions, so the accessible name ran together as
                        "Ada AdminYOU". The badge's margin is visual only. */}
                    {user.id === session.userId && ' '}
                    {user.id === session.userId && (
                      <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-neutral-700">
                        You
                      </span>
                    )}
                  </th>
                  <td className={`${TD} text-neutral-600`}>{user.email}</td>
                  <td className={TD}>
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
                            {formatLabel(r)}
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
                  <td className={`${TD} text-right`}>
                    <div className="flex items-center justify-end gap-4">
                      <Link
                        href={`/users/${user.id}`}
                        aria-label={`Edit access for ${user.name}`}
                        className="text-xs font-medium text-[#1a6ef5] hover:underline"
                      >
                        Access
                      </Link>
                      {user.id !== session.userId && (
                        <DeleteUserButton id={user.id} name={user.name} email={user.email} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-sm text-neutral-600">
                    No user accounts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs text-neutral-600">
          <span className="font-medium text-neutral-900 tabular-nums">{users.length}</span>{' '}
          {users.length === 1 ? 'account' : 'accounts'} · You cannot change your own role or delete
          your own account.
        </p>
        </div>
      </main>
  </>
  );
}
