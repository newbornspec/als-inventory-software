'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getNextPalletNumber,
  mergePallets,
  previewMerge,
  type MergePreview,
  type Pallet,
} from '@/lib/actions/pallets';
import { layoutLabel } from './pallet-filters';

// Merging is not undoable, so the dialog's job is to make the outcome obvious
// BEFORE it happens: which pallets, how many units each, what the result will
// hold, and — when it can't be done — exactly why, in the same breath.
//
// The blockers come from the server, which runs the identical check again under
// a row lock at merge time. This is the explanation; that is the enforcement.
export function MergeDialog({
  selected,
  onDone,
}: {
  selected: Pallet[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [palletNumber, setPalletNumber] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const ids = selected.map((p) => p.id);

  // Check on open, not on every selection change: it is a round trip, and the
  // answer is only needed once someone has actually asked to merge.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPreview(null);
    setError(null);
    previewMerge(ids).then((p) => live && setPreview(p));
    // Prefilled as a suggestion the operator can overwrite — the warehouse may
    // already have written a number on the physical pallet. Same endpoint the
    // New Pallet form uses.
    getNextPalletNumber().then((n) => live && setPalletNumber(n));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const node = dialogRef.current;
    node?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        openerRef.current?.focus();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const focusables = node.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await mergePallets(ids, { palletNumber, description });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpen(false);
    onDone();
    // Land on the pallet that now holds the stock — the merge's actual result.
    router.push(`/pallets/${res.pallet.id}`);
  }

  const blocked = !preview || preview.blockers.length > 0;
  const totalUnits = preview?.sources.reduce((n, s) => n + s.totalQuantity, 0) ?? 0;
  const totalLines = preview?.sources.reduce((n, s) => n + s.lineCount, 0) ?? 0;

  return (
    <>
      <button
        ref={openerRef}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="rounded-md border border-[var(--control-border)] bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
      >
        Merge {selected.length} pallets
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="merge-title"
            tabIndex={-1}
            className="my-8 w-full max-w-lg rounded-xl border border-neutral-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="merge-title" className="text-lg font-semibold">
              Merge pallets
            </h2>
            <p className="mt-1 text-sm text-neutral-600">
              The stock moves onto one new pallet. The originals stay as records
              showing what they contributed and where it went — they are not
              deleted, and nothing is counted twice.
            </p>

            <div aria-live="polite" className="mt-4">
              {!preview && <p className="text-sm text-neutral-600">Checking these pallets…</p>}

              {preview && preview.blockers.length > 0 && (
                <div className="rounded-lg border border-red-300 bg-red-50 p-3">
                  <p className="text-sm font-medium text-red-900">
                    These pallets cannot be merged
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-red-800">
                    {preview.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}

              {preview && preview.blockers.length === 0 && (
                <div className="rounded-lg border border-neutral-200">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Pallets to be merged</caption>
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs text-neutral-600">
                        <th scope="col" className="px-3 py-2 font-medium">Pallet</th>
                        <th scope="col" className="px-3 py-2 font-medium">Layout</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">Lines</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">Units</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sources.map((s) => (
                        <tr key={s.id} className="border-b border-neutral-100 last:border-0">
                          <td className="px-3 py-2 font-medium text-neutral-950">
                            {s.palletNumber}
                          </td>
                          <td className="px-3 py-2 text-neutral-600">
                            {layoutLabel(s.entryLayout ?? undefined)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{s.lineCount}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{s.totalQuantity}</td>
                        </tr>
                      ))}
                      <tr className="bg-neutral-50 font-medium">
                        <td className="px-3 py-2" colSpan={2}>
                          New pallet will hold
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{totalLines}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{totalUnits}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {preview && preview.blockers.length === 0 && (
              <div className="mt-4 space-y-3">
                <div>
                  <label htmlFor="merge-number" className="block text-sm font-medium">
                    New pallet number
                  </label>
                  <input
                    id="merge-number"
                    value={palletNumber}
                    onChange={(e) => setPalletNumber(e.target.value)}
                    className="field-underline mt-1 w-full text-sm"
                    placeholder="Leave blank to use the next number"
                  />
                </div>
                <div>
                  <label htmlFor="merge-description" className="block text-sm font-medium">
                    Description <span className="font-normal text-neutral-600">(optional)</span>
                  </label>
                  <input
                    id="merge-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="field-underline mt-1 w-full text-sm"
                    placeholder={`Merged from ${selected.map((p) => p.palletNumber).join(', ')}`}
                  />
                </div>
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              {error && (
                <span role="alert" className="mr-auto text-xs text-red-700">
                  {error}
                </span>
              )}
              <button
                onClick={() => setOpen(false)}
                className="rounded-md border border-[var(--control-border)] px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={blocked || busy}
                className="rounded-md bg-[#1a6ef5] px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {busy ? 'Merging…' : 'Merge pallets'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
