import Link from 'next/link';
import type { Pallet, PalletLine } from '@/lib/actions/pallets';

const dt = (iso: string) => new Date(iso).toLocaleString('en-GB');

// Both halves of the merge story, shown on whichever side of it this pallet
// sits. Rendered from the merge EVENT rather than from the lines, so a merged
// pallet still names its sources long after their stock has been sold on.
export function MergeHistory({ pallet }: { pallet: Pallet }) {
  const from = pallet.mergedFrom ?? [];
  const into = pallet.mergedInto ?? null;
  if (from.length === 0 && !into) return null;

  return (
    <div className="mt-4 space-y-3">
      {into && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">
            Merged into{' '}
            <Link href={`/pallets/${into.id}`} className="underline hover:no-underline">
              {into.palletNumber}
            </Link>
          </p>
          <p className="mt-0.5 text-sm text-amber-800">
            Its stock moved on {dt(into.mergedAt)}. This pallet is kept as a
            record and can no longer be changed.
          </p>
        </div>
      )}

      {from.length > 0 && (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
          <p className="text-sm text-neutral-800">
            <span className="font-medium">Created from:</span>{' '}
            {from.map((s, i) => (
              <span key={`${s.palletNumber}-${i}`}>
                {i > 0 && ', '}
                {/* The id goes null if the original is later deleted; the
                    number is a snapshot and always readable. */}
                {s.id ? (
                  <Link href={`/pallets/${s.id}`} className="underline hover:no-underline">
                    {s.palletNumber}
                  </Link>
                ) : (
                  s.palletNumber
                )}
                <span className="text-neutral-600">
                  {' '}
                  ({s.units} units)
                </span>
              </span>
            ))}
          </p>
          <p className="mt-0.5 text-xs text-neutral-600">Merged {dt(from[0].mergedAt)}</p>
        </div>
      )}
    </div>
  );
}

// What a merged pallet contributed, as it now sits on its successor. Derived
// from the lines' source_pallet_id — there is no second copy of this stock, so
// nothing here can drift out of step with the pallet that actually holds it.
export function ContributedLines({
  lines,
  destination,
}: {
  lines: PalletLine[];
  destination: string | null;
}) {
  if (lines.length === 0) return null;
  const units = lines.reduce((n, l) => n + l.quantity, 0);

  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold">
        Contents at merge
        {destination && (
          <span className="ml-2 text-sm font-normal text-neutral-600">
            — now on {destination}
          </span>
        )}
      </h2>
      <p className="mt-1 text-sm text-neutral-600">
        {lines.length} line{lines.length === 1 ? '' : 's'}, {units} unit
        {units === 1 ? '' : 's'}. Read-only: these items live on the pallet
        above and are counted there, not here.
      </p>

      <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Items this pallet contributed when it was merged
          </caption>
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs text-neutral-600">
              <th scope="col" className="px-3 py-2 font-medium">Item</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-neutral-100 last:border-0">
                <td className="px-3 py-2 text-neutral-950">{l.variant}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
