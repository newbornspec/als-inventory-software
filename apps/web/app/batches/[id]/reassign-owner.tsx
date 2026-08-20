'use client';

import { reassignBatchOwner } from '@/lib/actions/batches';

// Admin-only control to hand a lot to another user.
export function ReassignOwner({
  batchId,
  currentOwnerId,
  users,
}: {
  batchId: string;
  currentOwnerId: string | null;
  users: { id: string; name: string; role: string }[];
}) {
  const action = reassignBatchOwner.bind(null, batchId);
  return (
    <form action={action} className="mt-1 flex items-center gap-2">
      <select
        name="ownerId"
        defaultValue={currentOwnerId ?? ''}
        className="field-inline px-2 py-1 text-xs text-neutral-900"
        aria-label="Reassign owner"
      >
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} ({u.role})
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded border border-[var(--field-border)] px-2 py-1 text-xs text-neutral-950 hover:bg-neutral-100"
      >
        Reassign
      </button>
    </form>
  );
}
