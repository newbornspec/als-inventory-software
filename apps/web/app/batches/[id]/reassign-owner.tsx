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
        className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
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
        className="rounded border border-neutral-600 px-2 py-1 text-xs text-neutral-100 hover:bg-neutral-800"
      >
        Reassign
      </button>
    </form>
  );
}
