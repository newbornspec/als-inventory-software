'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { createOrder } from '@/lib/actions/sales';
import type { ActionState } from '@/lib/actions/assets';
import type { Customer } from '@/lib/actions/customers';

export function NewOrderForm({ customers }: { customers: Customer[] }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createOrder, {
    error: null,
  });

  return (
    <form action={formAction} className="mt-6 max-w-sm space-y-3">
      <div className="space-y-1">
        <label className="text-sm text-neutral-300">Customer</label>
        {customers.length > 0 ? (
          <select
            name="customerId"
            defaultValue=""
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm text-neutral-500">
            No customers yet —{' '}
            <Link href="/customers/new" className="underline">
              add one first
            </Link>
            .
          </p>
        )}
      </div>
      <div className="space-y-1">
        <label className="text-sm text-neutral-300">Customer reference (their PO)</label>
        <input
          name="orderRef"
          placeholder="PO-98765"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm text-neutral-300">Notes</label>
        <textarea
          name="notes"
          rows={2}
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
      </div>

      {state.error && <p className="text-sm text-red-400">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create order'}
      </button>
    </form>
  );
}
