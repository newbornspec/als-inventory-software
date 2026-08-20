'use client';

import { useActionState } from 'react';
import { createUser, type ActionState } from '@/lib/actions/users';

const ROLES = ['admin', 'manager', 'technician'];

export function NewUserForm() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createUser, {
    error: null,
  });

  return (
    <form action={formAction} className="mt-6 max-w-sm space-y-3">
      <div className="space-y-1">
        <label htmlFor="users-new-new-user-form-name" className="text-sm text-neutral-700">Name</label>
        <input id="users-new-new-user-form-name" name="name"
          required
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="users-new-new-user-form-email" className="text-sm text-neutral-700">Email</label>
        <input id="users-new-new-user-form-email" name="email"
          type="email"
          required
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="users-new-new-user-form-password" className="text-sm text-neutral-700">Temporary password</label>
        <input id="users-new-new-user-form-password" name="password"
          type="password"
          required
          minLength={8}
          className="field-underline w-full px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="users-new-new-user-form-role" className="text-sm text-neutral-700">Role</label>
        <select id="users-new-new-user-form-role" name="role"
          defaultValue="technician"
          className="field-underline w-full px-3 py-2 text-sm"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create user'}
      </button>
    </form>
  );
}
