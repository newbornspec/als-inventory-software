'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
    blurb: 'Excel-style grid: manufacturer, model, chassis, CPU, RAM, storage per column.',
    href: '/pallets/new/spec',
  },
];

export function NewPalletButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(LAYOUTS[0].key);

  function go() {
    const layout = LAYOUTS.find((l) => l.key === choice);
    if (layout) router.push(layout.href);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
      >
        New Pallet
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-950 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Create New Pallet</h2>
            <p className="mt-1 text-sm text-neutral-400">
              Choose how you’d like to enter this pallet. Both create the same pallet.
            </p>

            <div className="mt-4 space-y-2">
              {LAYOUTS.map((l) => (
                <label
                  key={l.key}
                  className={
                    'flex cursor-pointer gap-3 rounded-lg border p-3 ' +
                    (choice === l.key
                      ? 'border-neutral-400 bg-neutral-900'
                      : 'border-neutral-800 hover:bg-neutral-900/50')
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
                    <span className="block text-sm font-medium text-neutral-100">{l.title}</span>
                    <span className="mt-0.5 block text-xs text-neutral-400">{l.blurb}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900"
              >
                Cancel
              </button>
              <button
                onClick={go}
                className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
