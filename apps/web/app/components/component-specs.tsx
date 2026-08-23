import type { SpecRow } from '@/lib/hardware-spec';

// The component-specification table. One presentation, used everywhere a
// device's hardware is shown, so the same machine cannot read one way in the
// Audit workspace and another way in Goods In.
//
// Four columns by design: what the part IS, how many, who made it (or the
// architecture token that identifies it), and the part with its parameters
// composed into one line. The previous eight-column grid spread one sentence
// across a row of mostly-empty cells.

const FLAG_TONE: Record<string, string> = {
  bad: 'border-red-200 bg-red-50 text-red-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  good: 'border-emerald-200 bg-emerald-50 text-emerald-800',
};

export function ComponentSpecsTable({
  rows,
  title = 'Component specification metrics',
  caption,
}: {
  rows: SpecRow[];
  title?: string;
  caption: string;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">{title}</h3>
        <span className="text-xs text-neutral-500 tabular-nums">
          {rows.length} item{rows.length === 1 ? '' : 's'} scanned
        </span>
      </div>

      <div className="mt-2 overflow-x-auto rounded-md border border-neutral-200">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-neutral-50">
            <tr className="text-[11px] uppercase tracking-wide text-neutral-500">
              <th scope="col" className="px-3 py-2 font-medium">Component</th>
              <th scope="col" className="px-3 py-2 font-medium">Qty</th>
              <th scope="col" className="px-3 py-2 font-medium">Mfg / Arch</th>
              <th scope="col" className="px-3 py-2 font-medium">Model &amp; parameters</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.component}-${i}`} className="border-t border-neutral-100">
                <th scope="row" className="whitespace-nowrap px-3 py-2 font-semibold text-neutral-900">
                  {r.component}
                </th>
                <td className="px-3 py-2 tabular-nums text-neutral-600">{r.qty}</td>
                <td className="whitespace-nowrap px-3 py-2 text-neutral-600">{r.mfgArch}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-neutral-900">{r.params}</span>
                    {r.flag && (
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                          FLAG_TONE[r.flag.tone] ?? FLAG_TONE.warn
                        }`}
                      >
                        {r.flag.label}
                      </span>
                    )}
                  </div>
                  {r.sub && (
                    <div className="mt-0.5 font-mono text-[11px] text-neutral-500">{r.sub}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
