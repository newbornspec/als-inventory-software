'use client';

import { useState } from 'react';
import { login } from '@/lib/auth';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      // Full-page navigation (not router.push) so the browser reloads the app
      // from scratch — this guarantees the freshly deployed bundle is loaded,
      // avoiding stale server-action references after a deploy.
      window.location.href = '/dashboard';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setSubmitting(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-screen items-center justify-center bg-white px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-8"
      >
        <div>
          <h1 className="text-xl font-semibold text-neutral-950">Als Inventory</h1>
          <p className="mt-1 text-sm text-neutral-500">Sign in to continue</p>
        </div>

        <div className="space-y-1">
          <label htmlFor="email" className="text-sm text-neutral-700">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-[var(--field-border)] bg-white px-3 py-2 text-neutral-950 focus:border-[var(--field-border)]"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="text-sm text-neutral-700">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-[var(--field-border)] bg-white px-3 py-2 text-neutral-950 focus:border-[var(--field-border)]"
          />
        </div>

        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-[#1a6ef5] hover:bg-blue-600 py-2 font-medium text-white disabled:opacity-50"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
