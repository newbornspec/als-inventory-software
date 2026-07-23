'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPalletFromSpec, type SpecRow } from '@/lib/actions/pallets';
import type { LookupValue } from '@/lib/actions/lookups';
import type { Location } from '@/lib/data';

type Field = 'manufacturer' | 'model' | 'chassis' | 'cpu' | 'ram' | 'storage' | 'quantity';
type Row = Record<Field, string> & { id: number };

// Column order — also the order pasted Excel/TSV cells fill into.
const COLUMNS: { key: Field; label: string; list?: string; width: string }[] = [
  { key: 'manufacturer', label: 'Manufacturer', list: 'dl-manufacturer', width: 'min-w-[9rem]' },
  { key: 'model', label: 'Model', width: 'min-w-[11rem]' },
  { key: 'chassis', label: 'Chassis', list: 'dl-chassis', width: 'min-w-[8rem]' },
  { key: 'cpu', label: 'CPU', list: 'dl-cpu', width: 'min-w-[12rem]' },
  { key: 'ram', label: 'RAM', list: 'dl-ram', width: 'min-w-[7rem]' },
  { key: 'storage', label: 'Storage', list: 'dl-storage', width: 'min-w-[10rem]' },
  { key: 'quantity', label: 'Quantity', width: 'w-24' },
];

const inputCls =
  'w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500';
const cellCls =
  'w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm outline-none focus:border-neutral-500';

export function SpecPalletForm({
  locations,
  lookups,
}: {
  locations: Location[];
  lookups: LookupValue[];
}) {
  const router = useRouter();
  const nextId = useRef(0);
  const blank = (): Row => ({
    id: nextId.current++,
    manufacturer: '',
    model: '',
    chassis: '',
    cpu: '',
    ram: '',
    storage: '',
    quantity: '',
  });

  const [rows, setRows] = useState<Row[]>(() => [blank(), blank(), blank()]);
  const [meta, setMeta] = useState({ description: '', supplier: '', buyer: '', locationId: '' });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ col: Field; dir: 'asc' | 'desc' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = useMemo(() => lookups.filter((l) => l.active), [lookups]);
  const manufacturers = useMemo(() => active.filter((l) => l.category === 'manufacturer'), [active]);
  const models = useMemo(() => active.filter((l) => l.category === 'model'), [active]);
  const manIdByValue = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of manufacturers) m.set(x.value.trim().toLowerCase(), x.id);
    return m;
  }, [manufacturers]);
  const optsFor = (cat: string) => active.filter((l) => l.category === cat).map((l) => l.value);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      COLUMNS.some((c) => r[c.key].toLowerCase().includes(needle)),
    );
  }, [rows, q]);

  function setCell(id: number, key: Field, val: string) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [key]: val } : r)));
  }
  function removeRow(id: number) {
    setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : rs));
  }

  function sortBy(col: Field) {
    const dir = sort && sort.col === col && sort.dir === 'asc' ? 'desc' : 'asc';
    setSort({ col, dir });
    const mul = dir === 'asc' ? 1 : -1;
    setRows((prev) =>
      [...prev].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (col === 'quantity') return ((parseFloat(av) || 0) - (parseFloat(bv) || 0)) * mul;
        if (!av && bv) return 1; // blanks last, regardless of direction
        if (av && !bv) return -1;
        return av.localeCompare(bv) * mul;
      }),
    );
  }

  // Paste an Excel/TSV block starting from this cell, growing the grid as needed.
  function onPaste(rowId: number, startCol: number, e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text');
    if (!text || (!text.includes('\t') && !text.includes('\n'))) return; // single value → native paste
    e.preventDefault();
    const grid = text
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.split('\t'));
    while (grid.length && grid[grid.length - 1].every((c) => c.trim() === '')) grid.pop();
    if (grid.length === 0) return;

    setRows((prev) => {
      const next = prev.map((r) => ({ ...r }));
      const start = next.findIndex((r) => r.id === rowId);
      if (start < 0) return prev;
      grid.forEach((cells, r) => {
        const ti = start + r;
        while (ti >= next.length) next.push(blank());
        cells.forEach((cell, c) => {
          const col = COLUMNS[startCol + c];
          if (col) next[ti][col.key] = cell.trim();
        });
      });
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    const specRows: SpecRow[] = rows.map((r) => ({
      manufacturer: r.manufacturer,
      model: r.model,
      chassis: r.chassis,
      cpu: r.cpu,
      ram: r.ram,
      storage: r.storage,
      quantity: parseInt(r.quantity || '0', 10),
    }));
    const res = await createPalletFromSpec({ ...meta, rows: specRows });
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    router.push(`/pallets/${res.id}`);
  }

  const arrow = (col: Field) => (sort?.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="mt-6">
      <DataList id="dl-manufacturer" values={manufacturers.map((m) => m.value)} />
      <DataList id="dl-chassis" values={optsFor('chassis')} />
      <DataList id="dl-cpu" values={optsFor('cpu')} />
      <DataList id="dl-ram" values={optsFor('ram')} />
      <DataList id="dl-storage" values={optsFor('storage')} />
      {manufacturers.map((m) => (
        <DataList
          key={m.id}
          id={`dl-model-${m.id}`}
          values={models.filter((x) => x.parentId === m.id).map((x) => x.value)}
        />
      ))}

      <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm text-neutral-300">Description</span>
          <input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} placeholder="e.g. Mixed Dell tinies" className={inputCls} />
        </label>
        <label className="space-y-1">
          <span className="text-sm text-neutral-300">Location</span>
          <select value={meta.locationId} onChange={(e) => setMeta({ ...meta, locationId: e.target.value })} className={inputCls}>
            <option value="">Unassigned</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-sm text-neutral-300">Supplier</span>
          <input value={meta.supplier} onChange={(e) => setMeta({ ...meta, supplier: e.target.value })} className={inputCls} />
        </label>
        <label className="space-y-1">
          <span className="text-sm text-neutral-300">Buyer</span>
          <input value={meta.buyer} onChange={(e) => setMeta({ ...meta, buyer: e.target.value })} className={inputCls} />
        </label>
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search rows…"
          className="w-full max-w-xs rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {q ? `${visible.length} of ${rows.length}` : `${rows.length} rows`}
        </span>
      </div>

      <div className="mt-2 overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} className={`${c.width} px-3 py-2`}>
                  <button onClick={() => sortBy(c.key)} className="hover:text-neutral-200">
                    {c.label}
                    {arrow(c.key)}
                  </button>
                </th>
              ))}
              <th className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const manId = manIdByValue.get(r.manufacturer.trim().toLowerCase());
              return (
                <tr key={r.id} className="border-t border-neutral-800">
                  {COLUMNS.map((c, ci) => (
                    <td key={c.key} className="px-2 py-1">
                      <input
                        type={c.key === 'quantity' ? 'number' : 'text'}
                        min={c.key === 'quantity' ? 0 : undefined}
                        list={c.key === 'model' ? (manId ? `dl-model-${manId}` : undefined) : c.list}
                        value={r[c.key]}
                        onChange={(e) => setCell(r.id, c.key, e.target.value)}
                        onPaste={(e) => onPaste(r.id, ci, e)}
                        className={cellCls + (c.key === 'quantity' ? ' w-20' : '')}
                      />
                    </td>
                  ))}
                  <td className="px-2 py-1 text-center">
                    <button onClick={() => removeRow(r.id)} className="text-xs text-red-400 hover:underline" aria-label="Remove row">
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="px-3 py-6 text-center text-sm text-neutral-500">
                  No rows match “{q}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={() => setRows((rs) => [...rs, blank()])} className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900">
          + Add row
        </button>
        <button onClick={save} disabled={busy} className="rounded-md bg-neutral-100 px-4 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-50">
          {busy ? 'Saving…' : 'Save pallet'}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      <p className="mt-2 text-xs text-neutral-600">
        Tip: copy cells from Excel and paste into any cell to fill the grid. Click a column header to
        sort. New values you type are saved to the dropdown lists when you save.
      </p>
    </div>
  );
}

function DataList({ id, values }: { id: string; values: string[] }) {
  return (
    <datalist id={id}>
      {values.map((v) => (
        <option key={v} value={v} />
      ))}
    </datalist>
  );
}
