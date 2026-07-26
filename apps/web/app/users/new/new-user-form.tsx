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
        <label className="text-sm text-neutral-700">Name</label>
        <input
          name="name"
          required
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-300"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm text-neutral-700">Email</label>
        <input
          name="email"
          type="email"
          required
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-300"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm text-neutral-700">Temporary password</label>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-300"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm text-neutral-700">Role</label>
        <select
          name="role"
          defaultValue="technician"
          className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      {state.error && <p className="text-sm text-red-600">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#2b7fff] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create user'}
      </button>
    </form>
  );
}
