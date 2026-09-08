'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { resetUserPassword } from '@/lib/actions/users';

// Set a new password for someone who cannot get in.
//
// A prompt() rather than the confirm() the neighbouring buttons use, because
// this one needs a value typed rather than a yes/no. It is the only control in
// this row that does, and a full modal for one field would be more machinery
// than the page has anywhere else.
//
// The new password is shown to the admin in plain text by design: they have to
// read it out or type it into a message to hand it over. It is never displayed
// again and nothing stores it — the API keeps a bcrypt hash like any other.
export function ResetPasswordButton({
  id,
  name,
  email,
  isSelf,
}: {
  id: string;
  name: string;
  email: string;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function onReset() {
    const who = isSelf ? 'your own account' : `${name} (${email})`;
    const entered = window.prompt(
      `Set a new password for ${who}.\n\n` +
        'At least 8 characters. Write it down before you press OK — it is not shown again.\n\n' +
        'They are signed out of every device straight away and must sign in with the new password.',
    );
    if (entered === null) return; // cancelled

    const next = entered.trim();
    if (next.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setError(null);
    setDone(false);
    startTransition(async () => {
      try {
        await resetUserPassword(id, next);
        setDone(true);
        // Resetting your OWN password invalidates the token this page is using,
        // so send yourself to sign in again rather than leaving every
        // subsequent click failing with a 403.
        if (isSelf) router.push('/login');
        else router.refresh();
      } catch {
        setError('Could not change the password.');
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onReset}
        disabled={pending}
        aria-label={`Set a new password for ${name}`}
        className="text-xs font-medium text-neutral-700 hover:underline disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Reset password'}
      </button>
      {done && !isSelf && (
        <span role="status" className="text-xs text-green-700">
          Password changed
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </>
  );
}
