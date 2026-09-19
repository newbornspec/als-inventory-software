'use client';

import { useActionState, useState } from 'react';
import { updateUserAccess, type ActionState, type AppUser } from '@/lib/actions/users';
import { PermissionsPicker } from '../permissions-picker';

const ROLES = ['admin', 'manager', 'technician'];

export function EditAccessForm({ user, isSelf }: { user: AppUser; isSelf: boolean }) {
  const boundAction = updateUserAccess.bind(null, user.id);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(boundAction, {
    error: null,
  });
  const [role, setRole] = useState<string>(user.role);

  return (
    <form action={formAction} className="mt-6 max-w-2xl space-y-3">
      <div className="max-w-sm space-y-1">
        <label htmlFor="users-edit-access-role" className="text-sm text-neutral-700">Role</label>
        <select
          id="users-edit-access-role"
          name="role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={isSelf}
          className="field-underline w-full px-3 py-2 text-sm disabled:opacity-50"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {isSelf && (
          <p className="text-xs text-neutral-600">You cannot change your own role.</p>
        )}
      </div>

      {/* The saved role shows the SAVED grants; any other role shows that
          role's baseline, same rule as everywhere else. */}
      <PermissionsPicker role={role} initial={user.permissions} initialRole={user.role} />

      {/* The audit station signs in as one account every operator uses.
          Flagging it lets an erasure certificate say that no person was
          recorded, instead of a reader taking the account name for the
          person who wiped the drive (plan step 28). */}
      <div className="flex items-start gap-2 pt-2">
        <input
          id="users-edit-access-station"
          type="checkbox"
          name="isStation"
          defaultChecked={!!user.isStation}
          className="mt-1"
        />
        <div>
          <label htmlFor="users-edit-access-station" className="text-sm text-neutral-800">
            Station account (shared)
          </label>
          <p className="text-xs text-neutral-600">
            Tick for a login shared by several people, such as the audit station. Certificates for
            its wipes then say the operator was not recorded unless one was typed at the station.
          </p>
        </div>
      </div>

      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save access'}
      </button>
    </form>
  );
}
