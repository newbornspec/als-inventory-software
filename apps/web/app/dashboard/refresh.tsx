'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCw } from 'lucide-react';

// "Last updated" plus a working Refresh.
//
// The timestamp comes from the server as UTC and is rendered client-side, so it
// shows in the reader's own timezone rather than the server's — and rendering it
// only after mount avoids a hydration mismatch between the two.
//
// Refresh re-runs the server component (router.refresh()), so the figures are
// genuinely re-fetched rather than a cached payload being re-rendered. The busy
// state is announced, not just spun.
export function LastUpdated({ generatedAt }: { generatedAt: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    setShown(
      new Date(generatedAt).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
  }, [generatedAt]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-neutral-600">
        {/* Live so a screen reader hears the new time after a refresh. */}
        <span aria-live="polite">
          Last updated: {shown ?? '—'}
        </span>
      </p>
      <button
        type="button"
        onClick={() => startTransition(() => router.refresh())}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-lg border border-[var(--field-border)] px-3 py-1.5 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-50 disabled:opacity-60"
      >
        <RotateCw className={pending ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
        {pending ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}
