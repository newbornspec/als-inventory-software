'use client';

import { useState } from 'react';
import Link from 'next/link';
import { money } from '@/lib/money';
import { formatLabel } from '@/lib/asset-options';

export interface BatchAnalytics {
  batchId: string;
  batchNumber: string;
  owner: string | null;
  createdBy: string | null;
  source: string | null;
  createdAt: string;
  status: string;
  totalSubLots: number;
  totalAssets: number;
  unitsSold: number;
  totalCost: number | null;
  revenue: number;
  profit: number;
  marginPct: number | null;
  subLots: {
    lotId: string | null;
    lotNumber: string;
    description: string | null;
    assets: number;
    sold: number;
    cost: number;
    revenue: number;
    avgGrade: string | null;
    completionPct: number;
  }[];
}

const profitClass = (n: number) =>
  n > 0 ? 'text-emerald-700' : n < 0 ? 'text-red-600' : 'text-neutral-700';

// Batch → sub-lot drill-down. Each batch row expands to its sub-lot analytics;
// batch numbers and sub-lots link to the operational pages so context is never
// lost.
export function BatchAnalyticsTable({ rows }: { rows: BatchAnalytics[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (rows.length === 0) {
    return (
      <p className="mt-3 rounded-lg border border-neutral-200 px-4 py-6 text-center text-sm text-neutral-500">
        No purchase lots yet.
      </p>
    );
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-50 text-neutral-500">
          <tr>
            <th className="w-8 px-2 py-2" />
            <th className="px-3 py-2">Lot</th>
            <th className="px-3 py-2">Supplier</th>
            <th className="px-3 py-2">Owner</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">Sub-lots</th>
            <th className="px-3 py-2 text-right">Assets</th>
            <th className="px-3 py-2 text-right">Sold</th>
            <th className="px-3 py-2 text-right">Cost</th>
            <th className="px-3 py-2 text-right">Revenue</th>
            <th className="px-3 py-2 text-right">Profit</th>
            <th className="px-3 py-2 text-right">Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const isOpen = open.has(b.batchId);
            return (
              <FragmentRow key={b.batchId} b={b} isOpen={isOpen} onToggle={() => toggle(b.batchId)} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({
  b,
  isOpen,
  onToggle,
}: {
  b: BatchAnalytics;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-t border-neutral-200 hover:bg-neutral-50">
        <td className="px-2 py-2">
          {b.subLots.length > 0 && (
            <button onClick={onToggle} className="text-neutral-500 hover:text-neutral-900" aria-label={isOpen ? 'Collapse' : 'Expand'}>
              {isOpen ? '▾' : '▸'}
            </button>
          )}
        </td>
        <td className="px-3 py-2 text-neutral-900">
          <Link href={`/batches/${b.batchId}`} className="underline">
            {b.batchNumber}
          </Link>
        </td>
        <td className="px-3 py-2 text-neutral-500">{b.source ?? '—'}</td>
        <td className="px-3 py-2 text-neutral-500" title={b.createdBy ? `Created by ${b.createdBy}` : undefined}>
          {b.owner ?? '—'}
        </td>
        <td className="px-3 py-2">
          <span className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-700">
            {formatLabel(b.status)}
          </span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{b.totalSubLots}</td>
        <td className="px-3 py-2 text-right tabular-nums text-neutral-700">{b.totalAssets}</td>
        <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{b.unitsSold}</td>
        <td className="px-3 py-2 text-right text-neutral-500">
          {b.totalCost != null ? money(b.totalCost) : '—'}
        </td>
        <td className="px-3 py-2 text-right text-neutral-700">{money(b.revenue)}</td>
        <td className={'px-3 py-2 text-right font-medium ' + profitClass(b.profit)}>{money(b.profit)}</td>
        <td className="px-3 py-2 text-right text-neutral-500">
          {b.marginPct == null ? '—' : `${b.marginPct.toFixed(1)}%`}
        </td>
      </tr>
      {isOpen &&
        b.subLots.map((l, i) => (
          <tr key={l.lotId ?? `direct-${i}`} className="border-t border-neutral-200 bg-neutral-50">
            <td className="px-2 py-1.5" />
            <td className="px-3 py-1.5 pl-6 text-neutral-700" colSpan={2}>
              {l.lotId ? (
                <Link href={`/batches/${b.batchId}`} className="underline decoration-neutral-300">
                  {l.lotNumber}
                </Link>
              ) : (
                <span className="text-neutral-500">{l.lotNumber}</span>
              )}
              {l.description && <span className="ml-2 text-xs text-neutral-500">{l.description}</span>}
            </td>
            <td className="px-3 py-1.5 text-xs text-neutral-500" colSpan={2}>
              {l.avgGrade ? `Avg grade ${l.avgGrade}` : 'Ungraded'} · {l.completionPct.toFixed(0)}% audited
            </td>
            <td className="px-3 py-1.5 text-right text-xs text-neutral-500">
              {/* progress bar for completion */}
              <span className="ml-auto inline-block h-1.5 w-16 overflow-hidden rounded-sm bg-neutral-100 align-middle">
                <span
                  className="block h-full rounded-sm bg-[#199e70]"
                  style={{ width: `${Math.min(100, l.completionPct)}%` }}
                />
              </span>
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums text-neutral-500">{l.assets}</td>
            <td className="px-3 py-1.5 text-right tabular-nums text-neutral-500">{l.sold}</td>
            <td className="px-3 py-1.5 text-right text-neutral-500">{money(l.cost)}</td>
            <td className="px-3 py-1.5 text-right text-neutral-500">{money(l.revenue)}</td>
            <td className="px-3 py-1.5 text-right text-neutral-500" colSpan={2}>
              {money(l.revenue - l.cost)}
            </td>
          </tr>
        ))}
    </>
  );
}
