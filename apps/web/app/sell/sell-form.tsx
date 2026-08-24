'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { findSellable, type Sellable } from '@/lib/actions/sell-lookup';
import { sellAsset } from '@/lib/actions/sold';
import { formatLabel } from '@/lib/asset-options';

const FIELD = 'field-underline w-full px-3 py-2 text-sm';

// Selling is terminal and locks the record, so this deliberately has two steps:
// find the device, confirm what it is, THEN sell. A single "type a tag and hit
// sell" box would make an irreversible change on a typo.
export function SellForm() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Sellable[] | null>(null);
  const [chosen, setChosen] = useState<Sellable | null>(null);
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setDone(null);
    setChosen(null);
    const res = await findSellable(q);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      setMatches(null);
      return;
    }
    setMatches(res.matches ?? []);
    // Exactly one match is the common case with a scanner — skip straight to
    // confirming it, but still confirm.
    if (res.matches?.length === 1) setChosen(res.matches[0]);
  }

  async function confirmSell() {
    if (!chosen) return;
    const raw = price.trim();
    const value = raw === '' ? undefined : Number(raw);
    if (raw !== '' && (!Number.isFinite(value!) || value! < 0)) {
      setError('Sale price must be a number, or leave it blank.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await sellAsset(chosen.id, value);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setDone(`${chosen.tag} marked as sold.`);
    setChosen(null);
    setMatches(null);
    setQuery('');
    setPrice('');
    router.refresh();
  }

  return (
    <div className="max-w-xl">
      <form
        onSubmit={search}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-white p-4"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor="sell-q" className="block text-sm text-neutral-700">
            Scan or type a tag, serial or name
          </label>
          <input
            id="sell-q"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="U-000123"
            className={FIELD}
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-[var(--control-border)] px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50"
        >
          {busy ? 'Looking…' : 'Find'}
        </button>
      </form>

      {done && (
        <p role="status" className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          {done}{' '}
          <Link href="/sold" className="font-medium underline">
            See the Sold archive
          </Link>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}

      {matches !== null && matches.length === 0 && (
        <p className="mt-4 text-sm text-neutral-700">
          Nothing matched “{query}”. Devices already sold do not appear here —
          check the{' '}
          <Link href="/sold" className="text-blue-800 underline">
            Sold archive
          </Link>
          .
        </p>
      )}

      {matches && matches.length > 1 && !chosen && (
        <div className="mt-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">
            {matches.length} matches — pick one
          </h2>
          <ul className="mt-2 divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white">
            {matches.map((m) => (
              <li key={m.id}>
                <button
                  onClick={() => setChosen(m)}
                  className="flex w-full flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-left hover:bg-neutral-50"
                >
                  <span className="font-medium">{m.tag}</span>
                  <span className="text-sm text-neutral-700">{m.name}</span>
                  <span className="text-xs text-neutral-600">
                    {formatLabel(m.stockStatus)}
                    {m.location ? ` · ${m.location}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {chosen && (
        <div className="mt-4 rounded-xl border border-neutral-200 bg-white p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">Confirm the sale</h2>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-600">Device</dt>
              <dd className="font-medium">{chosen.tag}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-600">What it is</dt>
              <dd className="text-right">{chosen.name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-neutral-600">Status</dt>
              <dd>{formatLabel(chosen.stockStatus)}</dd>
            </div>
            {chosen.location && (
              <div className="flex justify-between gap-4">
                <dt className="text-neutral-600">Location</dt>
                <dd>{chosen.location}</dd>
              </div>
            )}
          </dl>

          <div className="mt-4 space-y-1">
            <label htmlFor="sell-price" className="block text-sm text-neutral-700">
              Sale price (£)
            </label>
            <input
              id="sell-price"
              type="number"
              min={0}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="optional"
              aria-describedby="sell-price-hint"
              className={`${FIELD} max-w-[12rem]`}
            />
            <p id="sell-price-hint" className="text-xs text-neutral-600">
              Leave blank if it is not known yet — it can be set later, and
              revenue simply will not count this unit until it is.
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={confirmSell}
              disabled={busy}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? 'Selling…' : `Mark ${chosen.tag} as sold`}
            </button>
            <button
              onClick={() => setChosen(null)}
              className="rounded-md border border-[var(--control-border)] px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
            >
              Cancel
            </button>
          </div>

          {/* Selling locks the record — only an admin can undo it. Saying so
              before the click, not after. */}
          <p className="mt-3 text-xs text-neutral-600">
            This is final: the device moves to the Sold archive and is locked.
            Only an admin can return it.
          </p>
        </div>
      )}
    </div>
  );
}
