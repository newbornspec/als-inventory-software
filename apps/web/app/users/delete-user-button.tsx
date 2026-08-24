'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteUser } from '@/lib/actions/users';

// Deleting an account was the one destructive action in this app that asked
// nothing first: a bare form submit in a table row, one click, irreversible,
// and no server-side guard either. Everything else confirms — selling an asset,
// deleting a lot, a sub-lot, a device, a lookup value, changing a lot status —
// so this matches them rather than inventing a new pattern.
//
// The message names the person and the address, because the rows differ only
// by those and the whole risk here is hitting the wrong line.
export function DeleteUserButton({ id, name, email }: { id: string; name: string; email: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onDelete() {
    const message =
      `Delete the account for ${name} (${email})?\n\n` +
      '• They lose access immediately\n' +
      '• Work already recorded against them keeps their name\n\n' +
      'This cannot be undone.';
    if (!window.confirm(message)) return;

    setError(null);
    startTransition(async () => {
      try {
        await deleteUser(id);
        router.refresh();
      } catch {
        setError('Could not delete this account.');
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        aria-label={`Delete the account for ${name}`}
        className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50"
      >
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </>
  );
}
