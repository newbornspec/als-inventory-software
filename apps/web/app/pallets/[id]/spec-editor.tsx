'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { savePalletSpec, type PalletLine, type SpecRow } from '@/lib/actions/pallets';
import { sellPalletLine } from '@/lib/actions/sold';
import type { LookupValue } from '@/lib/actions/lookups';
import type { Location } from '@/lib/data';
import { PALLET_MANUFACTURERS, SPEC_CPUS, SPEC_RAM, ramCell } from '@/lib/asset-options';

type Field = 'manufacturer' | 'model' | 'chassis' | 'cpu' | 'gen' | 'ram' | 'storage' | 'quantity';
// lineId ties a row to its saved pallet line (''=not saved yet) — needed to
// sell from the grid. Refreshed from the server response on every save, since
// saving recreates the lines.
type Row = Record<Field, string> & { id: number; lineId: string };

// The persistent Layout 2 editor: a spec pallet always opens back into this
// grid, so it can be edited, saved and re-edited any time. Saving replaces the
// pallet's lines with the grid contents.

// Column order — also the order pasted Excel/TSV cells fill into.
// `options` makes a column a restricted dropdown; `list` keeps it a free-text
// input backed by the admin-managed lookup suggestions.
const COLUMNS: {
  key: Field;
  label: string;
  list?: string;
  options?: string[];
  width: string;
}[] = [
  { key: 'manufacturer', label: 'Manufacturer', options: PALLET_MANUFACTURERS, width: 'min-w-[9rem]' },
  { key: 'model', label: 'Model', width: 'min-w-[11rem]' },
  { key: 'chassis', label: 'Chassis', list: 'dl-chassis', width: 'min-w-[8rem]' },
  { key: 'cpu', label: 'CPU', options: SPEC_CPUS, width: 'min-w-[12rem]' },
  { key: 'gen', label: 'Gen', list: 'dl-gen', width: 'min-w-[6rem]' },
  { key: 'ram', label: 'RAM', options: SPEC_RAM, width: 'min-w-[7rem]' },
  { key: 'storage', label: 'Storage', list: 'dl-storage', width: 'min-w-[10rem]' },
  { key: 'quantity', label: 'Quantity', width: 'w-24' },
];

const inputCls =
  'w-full rounded-md border border-[var(--field-border)] bg-white px-3 py-2 text-sm focus:border-[var(--field-border)]';
const cellCls =
  'w-full rounded border border-[var(--field-border)] bg-white px-2 py-1.5 text-sm focus:border-[var(--field-border)]';

export interface SpecEditorMeta {
  description: string;
  supplier: string;
  buyer: string;
  locationId: string;
}

export function SpecEditor({
  palletId,
  initialMeta,
  initialRows,
  locations,
  lookups,
}: {
  palletId: string;
  initialMeta: SpecEditorMeta;
  initialRows: (Record<Field, string> & { lineId?: string })[];
  locations: Location[];
  lookups: LookupValue[];
}) {
  const router = useRouter();
  const nextId = useRef(0);
  const blank = (): Row => ({
    id: nextId.current++,
    lineId: '',
    manufacturer: '',
    model: '',
    chassis: '',
    cpu: '',
    gen: '',
    ram: '',
    storage: '',
    quantity: '',
  });

  // Rebuild grid rows from the server's lines — used at mount (via the page's
  // initialRows) and after every save, so lineIds always match reality.
  const rowsFromLines = (lines: PalletLine[]): Row[] =>
    lines.map((l) => ({
      id: nextId.current++,
      lineId: l.id,
      manufacturer: l.product?.manufacturer ?? '',
      model: l.product?.model ?? (l.product ? '' : l.variant),
      chassis: l.product?.chassis ?? '',
      cpu: l.product?.cpu ?? '',
      gen: l.product?.gen ?? '',
      ram: ramCell(l.product?.ramGb),
      storage: l.product?.storage ?? '',
      quantity: String(l.quantity),
    }));

  const [rows, setRows] = useState<Row[]>(() => {
    const initial = initialRows.map((r) => ({ ...r, lineId: r.lineId ?? '', id: nextId.current++ }));
    return initial.length > 0 ? initial : [blank(), blank(), blank()];
  });
  const [meta, setMeta] = useState(initialMeta);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ col: Field; dir: 'asc' | 'desc' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
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

  // Paste is handled on the document, not per input. <select> is not editable,
  // so it never fires a paste event of its own — binding the handler to each
  // input (as this did) silently killed pasting a block that starts in
  // Manufacturer, CPU or RAM, which is where a full Excel row starts.
  //
  // The target cell is read off the focused element at paste time rather than
  // tracked as focus moves: one source of truth, and nothing to drift.
  useEffect(() => {
    function onDocPaste(e: ClipboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      const rowId = Number(el?.dataset?.rowId);
      const col = Number(el?.dataset?.col);
      if (!el?.dataset?.rowId || Number.isNaN(rowId) || Number.isNaN(col)) return;
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text || (!text.includes('\t') && !text.includes('\n'))) return; // single value → native paste
      e.preventDefault();
      pasteGrid(text, rowId, col);
    }
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
  });

  // Paste an Excel/TSV block starting from this cell, growing the grid as needed.
  function pasteGrid(text: string, rowId: number, startCol: number) {
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
    setSaved(false);
    const specRows: SpecRow[] = rows.map((r) => ({
      manufacturer: r.manufacturer,
      model: r.model,
      chassis: r.chassis,
      cpu: r.cpu,
      gen: r.gen,
      ram: r.ram,
      storage: r.storage,
      quantity: parseInt(r.quantity || '0', 10),
    }));
    const res = await savePalletSpec(palletId, { ...meta, rows: specRows });
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    // Adopt the server's rows (fresh lineIds; empty rows dropped) so in-grid
    // selling keeps working after the save.
    const fresh = rowsFromLines(res.pallet?.lines ?? []);
    setRows(fresh.length > 0 ? fresh : [blank(), blank(), blank()]);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    router.refresh(); // updates the totals/header rendered by the server page
  }

  // Sell all or part of a saved row's quantity straight from the grid — the
  // quantity moves to the Sold page and the row shrinks or disappears.
  async function sellRow(row: Row) {
    const max = parseInt(row.quantity || '0', 10);
    if (!row.lineId || max <= 0) return;
    const raw = window.prompt(`Sell how many? (1–${max})`, String(max));
    if (raw === null) return;
    const qty = Math.min(Math.max(1, parseInt(raw, 10) || 0), max);
    const priceRaw = window.prompt(
      `Total sale price for the ${qty} unit${qty === 1 ? '' : 's'} £ (optional — leave blank to skip)`,
      '',
    );
    const salePrice =
      priceRaw && !isNaN(parseFloat(priceRaw)) ? Math.max(0, parseFloat(priceRaw)) : undefined;
    setError(null);
    const res = await sellPalletLine(palletId, row.lineId, qty, salePrice);
    if (res.error) {
      setError(res.error);
      return;
    }
    setRows((rs) =>
      qty >= max
        ? rs.filter((r) => r.id !== row.id)
        : rs.map((r) => (r.id === row.id ? { ...r, quantity: String(max - qty) } : r)),
    );
    router.refresh();
  }

  const arrow = (col: Field) => (sort?.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="mt-6">
      {/* Manufacturer, CPU and RAM are restricted dropdowns now, so their
          suggestion lists are gone. Chassis, Gen and Storage stay free text
          backed by the admin-managed lookups. */}
      <DataList id="dl-chassis" values={optsFor('chassis')} />
      <DataList id="dl-gen" values={optsFor('gen')} />
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
          <span className="text-sm text-neutral-700">Description</span>
          <input value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} placeholder="e.g. Mixed Dell tinies" className={inputCls} />
        </label>
        <label className="space-y-1">
          <span className="text-sm text-neutral-700">Location</span>
          <select value={meta.locationId} onChange={(e) => setMeta({ ...meta, locationId: e.target.value })} className={inputCls}>
            <option value="">Unassigned</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-sm text-neutral-700">Supplier</span>
          <input value={meta.supplier} onChange={(e) => setMeta({ ...meta, supplier: e.target.value })} className={inputCls} />
        </label>
        <label className="space-y-1">
          <span className="text-sm text-neutral-700">Buyer</span>
          <input value={meta.buyer} onChange={(e) => setMeta({ ...meta, buyer: e.target.value })} className={inputCls} />
        </label>
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <input
          aria-label="Search rows"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search rows…"
          className="w-full max-w-xs rounded-md border border-[var(--field-border)] bg-white px-3 py-1.5 text-sm focus:border-[var(--field-border)]"
        />
        <span className="shrink-0 text-xs text-neutral-500">
          {q ? `${visible.length} of ${rows.length}` : `${rows.length} rows`}
        </span>
      </div>

      <div role="region" aria-label="Specification grid" tabIndex={0} className="mt-2 overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Pallet specification grid</caption>
          <thead className="bg-neutral-50 text-neutral-500">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  scope="col"
                  key={c.key}
                  aria-sort={
                    sort?.col === c.key
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className={`${c.width} px-3 py-2`}
                >
                  <button
                    onClick={() => sortBy(c.key)}
                    aria-label={`Sort by ${c.label}`}
                    className="hover:text-neutral-900"
                  >
                    {c.label}
                    <span aria-hidden="true">{arrow(c.key)}</span>
                  </button>
                </th>
              ))}
              <th scope="col" className="w-28 px-3 py-2">
                <span className="sr-only">Row actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, ri) => {
              const manId = manIdByValue.get(r.manufacturer.trim().toLowerCase());
              return (
                <tr key={r.id} className="border-t border-neutral-200">
                  {COLUMNS.map((c, ci) => (
                    <td key={c.key} className="px-2 py-1">
                      {c.options ? (
                        <select
                          aria-label={`${c.label}, row ${ri + 1}`}
                          data-row-id={r.id}
                          data-col={ci}
                          value={r[c.key]}
                          onChange={(e) => setCell(r.id, c.key, e.target.value)}
                          className={cellCls}
                        >
                          <option value="">—</option>
                          {withOwnValue(c.options, r[c.key]).map((o) => (
                            <option key={o} value={o} className="bg-white">
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          aria-label={`${c.label}, row ${ri + 1}`}
                          data-row-id={r.id}
                          data-col={ci}
                          type={c.key === 'quantity' ? 'number' : 'text'}
                          min={c.key === 'quantity' ? 0 : undefined}
                          list={c.key === 'model' ? (manId ? `dl-model-${manId}` : undefined) : c.list}
                          value={r[c.key]}
                          onChange={(e) => setCell(r.id, c.key, e.target.value)}
                          className={cellCls + (c.key === 'quantity' ? ' w-20' : '')}
                        />
                      )}
                    </td>
                  ))}
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-2">
                      {r.lineId && parseInt(r.quantity || '0', 10) > 0 && (
                        <button
                          onClick={() => void sellRow(r)}
                          className="text-xs text-emerald-700 hover:underline"
                          title="Sell all or part of this row"
                        >
                          Sell…
                        </button>
                      )}
                      <button
                        onClick={() => removeRow(r.id)}
                        className="text-xs text-red-600 hover:underline"
                        aria-label="Remove row"
                      >
                        Remove
                      </button>
                    </div>
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
        <button onClick={() => setRows((rs) => [...rs, blank()])} className="rounded-md border border-[var(--field-border)] px-3 py-1.5 text-sm text-neutral-700 hover:bg-white">
          + Add row
        </button>
        <button onClick={save} disabled={busy} className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        {saved && (
          <span role="status" className="text-xs text-emerald-800">
            <span aria-hidden="true">✓ </span>Saved
          </span>
        )}
        {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        Tip: copy cells from Excel and paste into any cell to fill the grid. Click a column header to
        sort. New values you type are saved to the dropdown lists when you save. Saving replaces the
        pallet&apos;s contents with this grid.
      </p>
    </div>
  );
}

// A row may hold something the dropdown no longer offers — pasted from Excel,
// or saved before the list was narrowed. Show it as an extra option for that row
// only: a select whose options omit its value renders blank, and the next edit
// would save that blank over real data.
function withOwnValue(options: string[], current: string): string[] {
  const v = (current ?? '').trim();
  return v && !options.includes(v) ? [...options, v] : options;
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
