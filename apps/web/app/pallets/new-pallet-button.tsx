'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createEmptySpecPallet } from '@/lib/actions/pallets';

// Add future entry methods here (CSV import, audit import…) and they appear in
// the chooser automatically — nothing else needs to change.
const LAYOUTS = [
  {
    key: 'variant',
    title: 'Layout 1 – Variant Entry',
    blurb: 'Quick entry: one description per row (e.g. “Dell 3050 i5 7th Gen”) with a quantity.',
    href: '/pallets/new',
  },
  {
    key: 'spec',
    title: 'Layout 2 – Specification Table',
    blurb:
      'Excel-style grid: manufacturer, model, chassis, CPU, Gen, RAM, storage per column. Creates the pallet straight away — come back and edit it in the grid any time.',
    href: null,
  },
];

export function NewPalletButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(LAYOUTS[0].key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    // Layout 2 generates the pallet (number and all) immediately; its page
    // opens straight into the persistent grid editor.
    if (choice === 'spec') {
      setBusy(true);
      setError(null);
      const res = await createEmptySpecPallet();
      setBusy(false);
      if (res.error || !res.id) {
        setError(res.error ?? 'Failed to create pallet.');
        return;
      }
      router.push(`/pallets/${res.id}`);
      return;
    }
    const layout = LAYOUTS.find((l) => l.key === choice);
    if (layout?.href) router.push(layout.href);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-[#2b7fff] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white"
      >
        New Pallet
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Create New Pallet</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Choose how you’d like to enter this pallet. Both create the same pallet.
            </p>

            <div className="mt-4 space-y-2">
              {LAYOUTS.map((l) => (
                <label
                  key={l.key}
                  className={
                    'flex cursor-pointer gap-3 rounded-lg border p-3 ' +
                    (choice === l.key
                      ? 'border-neutral-300 bg-white'
                      : 'border-neutral-200 hover:bg-neutral-50')
                  }
                >
                  <input
                    type="radio"
                    name="layout"
                    value={l.key}
                    checked={choice === l.key}
                    onChange={() => setChoice(l.key)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium text-neutral-950">{l.title}</span>
                    <span className="mt-0.5 block text-xs text-neutral-500">{l.blurb}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              {error && <span className="mr-auto text-xs text-red-600">{error}</span>}
              <button
                onClick={() => setOpen(false)}
                className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 hover:bg-white"
              >
                Cancel
              </button>
              <button
                onClick={go}
                disabled={busy}
                className="rounded-md bg-[#2b7fff] hover:bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? 'Creating…' : 'Continue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
