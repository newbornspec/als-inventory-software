'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { ReconciliationResult } from '@/lib/actions/batches';

// The supplier's manifest, diffed against what was actually scanned in.
//
// Two things this table did not do before, both of which matter during a
// receive. It rendered every line — a 500-row manifest is ~18,500px of table
// with no search and no filter, so the only way past it was to scroll — and it
// printed the matched device as plain text when the reconciliation payload has
// carried `matchedAssetId` all along. During receiving the question is almost
// always "what is still missing?", so that is a filter, not a scroll.
const PAGE_SIZE = 25;

const TH =
  'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500';
const TD = 'px-4 py-3 text-left text-sm';

type Filter = 'all' | 'found' | 'missing';

type Row = {
  key: string;
  identifier: string;
  manufacturer: string | null;
  model: string | null;
  cpu: string | null;
  ramGb: number | null;
  grade: string | null;
  quantity: number;
  status: 'found' | 'missing' | 'quantity';
  matchedAssetId: string | null;
  matchedTag: string | null;
};

export function ManifestTable({ recon }: { recon: ReconciliationResult }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);

  const rows: Row[] = useMemo(() => {
    const serialized: Row[] = recon.lines.map((l) => ({
      key: l.expected.id,
      identifier: l.expected.serialNumber ?? l.expected.assetTag ?? '—',
      manufacturer: l.expected.manufacturer,
      model: l.expected.model,
      cpu: l.expected.cpu,
      ramGb: l.expected.ramGb,
      grade: l.expected.grade,
      quantity: l.expected.quantity,
      status: l.status,
      matchedAssetId: l.matchedAssetId,
      matchedTag: l.matchedTag,
    }));
    // Bulk lines carry no serial, so they can be neither found nor missing —
    // they are reported, not force-matched (expected-line-items.service.ts).
    const bulk: Row[] = recon.quantityOnly.map((it) => ({
      key: it.id,
      identifier: '—',
      manufacturer: it.manufacturer,
      model: it.model,
      cpu: it.cpu,
      ramGb: it.ramGb,
      grade: it.grade,
      quantity: it.quantity,
      status: 'quantity',
      matchedAssetId: null,
      matchedTag: null,
    }));
    return [...serialized, ...bulk];
  }, [recon]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== 'all' && r.status !== filter) return false;
      if (!needle) return true;
      return [r.identifier, r.manufacturer, r.model, r.cpu, r.grade]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [rows, q, filter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const start = current * PAGE_SIZE;
  const shown = filtered.slice(start, start + PAGE_SIZE);

  function change(next: () => void) {
    next();
    setPage(0);
  }

  const chip = (value: Filter, label: string, count: number) => {
    const active = filter === value;
    return (
      <button
        key={value}
        type="button"
        onClick={() => change(() => setFilter(value))}
        aria-pressed={active}
        className={
          'rounded-full border px-2.5 py-1 text-xs tabular-nums transition-colors ' +
          (active
            ? 'border-[#1a6ef5] bg-blue-50 font-medium text-[#1a6ef5]'
            : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50')
        }
      >
        {label} <span className="font-medium">{count}</span>
      </button>
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <input
          aria-label="Search the supplier manifest"
          value={q}
          onChange={(e) => change(() => setQ(e.target.value))}
          placeholder="Search the manifest — serial, make, model, CPU…"
          className="field-underline w-full max-w-sm px-3 py-1.5 text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          {chip('all', 'All', rows.length)}
          {chip('missing', 'Missing', recon.summary.missing)}
          {chip('found', 'Found', recon.summary.found)}
        </div>
      </div>

      <div
        role="region"
        aria-label="Supplier manifest compared with what was scanned in"
        tabIndex={0}
        className="relative mt-3 min-w-0 overflow-x-auto rounded-lg border border-neutral-200"
      >
        <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            Expected inventory from the supplier manifest, compared with what was scanned in
          </caption>
          <thead className="bg-neutral-50">
            <tr>
              <th scope="col" className={TH}>
                Serial / tag
              </th>
              <th scope="col" className={TH}>
                Manufacturer
              </th>
              <th scope="col" className={TH}>
                Model
              </th>
              <th scope="col" className={TH}>
                CPU
              </th>
              <th scope="col" className={TH}>
                RAM
              </th>
              <th scope="col" className={TH}>
                Grade
              </th>
              <th scope="col" className={TH}>
                Qty
              </th>
              <th scope="col" className={TH}>
                Received
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className="border-t border-neutral-200">
                <th scope="row" className={`${TD} font-normal text-neutral-950`}>
                  {r.status === 'quantity' ? (
                    <span className="text-neutral-600">— (bulk line)</span>
                  ) : (
                    r.identifier
                  )}
                </th>
                <td className={`${TD} text-neutral-700`}>{r.manufacturer ?? '—'}</td>
                <td className={`${TD} text-neutral-700`}>{r.model ?? '—'}</td>
                <td className={`${TD} text-neutral-600`}>{r.cpu ?? '—'}</td>
                <td className={`${TD} tabular-nums text-neutral-600`}>{r.ramGb ?? '—'}</td>
                <td className={`${TD} text-neutral-600`}>{r.grade ?? '—'}</td>
                <td className={`${TD} tabular-nums text-neutral-700`}>{r.quantity}</td>
                <td className={TD}>
                  {r.status === 'found' ? (
                    // The payload has always known which device satisfied this
                    // line; printing it as a link is the drill-through the
                    // receiving workflow actually wants.
                    r.matchedAssetId ? (
                      <Link
                        href={`/assets/${r.matchedAssetId}`}
                        aria-label={`Open the device that matched ${r.identifier}`}
                        className="text-[#1a6ef5] hover:underline"
                      >
                        Found · {r.matchedTag ?? 'view'}
                      </Link>
                    ) : (
                      <span className="text-emerald-800">Found</span>
                    )
                  ) : r.status === 'missing' ? (
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                      Not scanned in
                    </span>
                  ) : (
                    <span className="text-neutral-500">Not serialised</span>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-neutral-600">
                  {rows.length === 0
                    ? 'No supplier list imported yet.'
                    : 'No manifest lines match this search.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-600">
        <span>
          Showing{' '}
          <span className="font-medium tabular-nums text-neutral-900">
            {filtered.length === 0 ? 0 : start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)}
          </span>{' '}
          of <span className="font-medium tabular-nums text-neutral-900">{filtered.length}</span>{' '}
          manifest line{filtered.length === 1 ? '' : 's'}
        </span>
        {pageCount > 1 && (
          <span className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={current === 0}
              className="rounded-md border border-[var(--control-border)] px-2 py-1 text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="tabular-nums">
              Page {current + 1} of {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={current >= pageCount - 1}
              className="rounded-md border border-[var(--control-border)] px-2 py-1 text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
            >
              Next
            </button>
          </span>
        )}
      </div>
    </>
  );
}
