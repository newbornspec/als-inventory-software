'use client';

import { useRouter, useSearchParams } from 'next/navigation';

export interface FilterOptions {
  batches: { id: string; label: string }[];
  suppliers: string[];
  manufacturers: string[];
  categories: string[];
  grades: { value: string; label: string }[];
}

// Cross-report dimension filters. Each select updates its URL param (preserving
// the date range) and reloads the page; the server threads them into the
// device-based sections. Kept in the URL so views are shareable/bookmarkable.
export function FilterBar({ options }: { options: FilterOptions }) {
  const router = useRouter();
  const params = useSearchParams();

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/reports?${next.toString()}`);
  };

  const clearAll = () => {
    const next = new URLSearchParams(params.toString());
    for (const k of ['batchId', 'supplier', 'manufacturer', 'category', 'grade']) next.delete(k);
    router.push(`/reports?${next.toString()}`);
  };

  const active =
    ['batchId', 'supplier', 'manufacturer', 'category', 'grade'].filter((k) => params.get(k)).length;

  const cls =
    'rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs outline-none focus:border-neutral-500';

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-neutral-500">Filters:</span>

      <select value={params.get('batchId') ?? ''} onChange={(e) => set('batchId', e.target.value)} className={cls}>
        <option value="">All lots</option>
        {options.batches.map((b) => (
          <option key={b.id} value={b.id}>{b.label}</option>
        ))}
      </select>

      <select value={params.get('supplier') ?? ''} onChange={(e) => set('supplier', e.target.value)} className={cls}>
        <option value="">All suppliers</option>
        {options.suppliers.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      <select value={params.get('manufacturer') ?? ''} onChange={(e) => set('manufacturer', e.target.value)} className={cls}>
        <option value="">All manufacturers</option>
        {options.manufacturers.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>

      <select value={params.get('category') ?? ''} onChange={(e) => set('category', e.target.value)} className={cls}>
        <option value="">All categories</option>
        {options.categories.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>

      <select value={params.get('grade') ?? ''} onChange={(e) => set('grade', e.target.value)} className={cls}>
        <option value="">All grades</option>
        {options.grades.map((g) => (
          <option key={g.value} value={g.value}>{g.label}</option>
        ))}
      </select>

      {active > 0 && (
        <button onClick={clearAll} className="text-xs text-neutral-500 hover:text-neutral-300">
          Clear filters ({active})
        </button>
      )}
    </div>
  );
}
