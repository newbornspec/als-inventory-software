'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { reassignBatchOwner } from '@/lib/actions/batches';

// Admin-only control to hand a lot to another user.
//
// Two problems this closes. When a lot had NO owner the select's defaultValue
// was '' and no option carried that value, so the browser fell back to the first
// user in the list — a real person's name rendered directly under a field
// reading "Owner: —", which reads as a statement of fact rather than an empty
// picker. And ownership is an access axis, not a label: a scoped manager only
// sees lots they own, so handing one over removes it from whoever was working
// it. That now says so before it happens.
export function ReassignOwner({
  batchId,
  batchNumber,
  currentOwnerId,
  currentOwnerName,
  users,
}: {
  batchId: string;
  batchNumber: string;
  currentOwnerId: string | null;
  currentOwnerName: string | null;
  users: { id: string; name: string; role: string }[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(currentOwnerId ?? '');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value || value === currentOwnerId) return;
    const next = users.find((u) => u.id === value);
    const losing = currentOwnerName
      ? `${currentOwnerName} loses access to it`
      : 'it stops being visible to every manager';
    if (
      !window.confirm(
        `Hand ${batchNumber} to ${next?.name ?? 'this user'}?\n\n` +
          `• they become responsible for the lot\n` +
          `• ${losing}\n\n` +
          `Ownership controls who can open this lot, not just whose name is on it.`,
      )
    )
      return;

    setError(null);
    startTransition(async () => {
      const data = new FormData();
      data.set('ownerId', value);
      const res = await reassignBatchOwner(batchId, data);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-1 flex flex-wrap items-center gap-2">
      <select
        name="ownerId"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={pending}
        className="field-inline px-2 py-1 text-xs text-neutral-900 disabled:opacity-50"
        aria-label={`Reassign ${batchNumber} to another owner`}
      >
        {/* Explicit empty option so an unowned lot shows "unowned" rather than
            silently selecting the first name in the list. */}
        <option value="">— Unowned —</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} ({u.role})
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending || !value || value === currentOwnerId}
        className="rounded border border-[var(--control-border)] px-2 py-1 text-xs text-neutral-950 hover:bg-neutral-100 disabled:opacity-40"
      >
        {pending ? 'Reassigning…' : 'Reassign'}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </form>
  );
}
