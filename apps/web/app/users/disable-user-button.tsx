'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setUserDisabled } from '@/lib/actions/users';

// Switch an account off without deleting it — the "someone left" case.
//
// This is the option that should normally be reached for instead of Delete.
// Every foreign key to users is ON DELETE SET NULL (18 of them), so deleting an
// account strips their name off every audit, wipe, sale and photo they touched.
// Disabling stops the access and leaves the record intact, which is what an
// ITAD client is really asking about when they ask who wiped a device.
//
// Styled deliberately quieter than Delete: neutral, not red. It is the
// reversible one, and the destructive-looking control should be the one that
// actually destroys something.
export function DisableUserButton({
  id,
  name,
  email,
  disabled,
}: {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onToggle() {
    const message = disabled
      ? `Re-enable the account for ${name} (${email})?\n\n` +
        '• They can sign in again straight away\n' +
        '• Their previous access and permissions are unchanged'
      : `Disable the account for ${name} (${email})?\n\n` +
        '• They are signed out and cannot sign back in\n' +
        '• Any phone or audit station signed in as them stops working\n' +
        '• Everything they have already recorded keeps their name\n\n' +
        'You can re-enable the account at any time.';
    if (!window.confirm(message)) return;

    setError(null);
    startTransition(async () => {
      try {
        await setUserDisabled(id, !disabled);
        router.refresh();
      } catch {
        // The API refuses two cases with a reason: disabling yourself, and
        // disabling the last active admin. Both arrive here as a failure, so
        // the message has to cover them without claiming to know which.
        setError(
          disabled ? 'Could not re-enable this account.' : 'Could not disable this account.',
        );
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        disabled={pending}
        aria-label={
          disabled ? `Re-enable the account for ${name}` : `Disable the account for ${name}`
        }
        className="text-xs font-medium text-neutral-700 hover:underline disabled:opacity-50"
      >
        {pending ? (disabled ? 'Enabling…' : 'Disabling…') : disabled ? 'Enable' : 'Disable'}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </>
  );
}
