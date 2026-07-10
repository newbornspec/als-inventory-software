'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { importExpectedLineItems, type ExpectedLineItemInput } from '@/lib/actions/batches';

// Our target fields and the header names we'll try to auto-match against.
const TARGET_FIELDS: { key: keyof ExpectedLineItemInput; label: string; aliases: string[] }[] = [
  { key: 'assetTag', label: 'Asset tag', aliases: ['asset tag', 'asset', 'tag', 'asset id', 'assettag'] },
  { key: 'serialNumber', label: 'Serial number', aliases: ['serial', 'serial number', 'serial no', 'sn', 'service tag'] },
  { key: 'manufacturer', label: 'Manufacturer', aliases: ['manufacturer', 'make', 'brand', 'vendor'] },
  { key: 'model', label: 'Model', aliases: ['model', 'model number', 'model no'] },
  { key: 'cpu', label: 'CPU', aliases: ['cpu', 'processor', 'proc'] },
  { key: 'ramGb', label: 'RAM (GB)', aliases: ['ram', 'memory', 'ram gb', 'ram (gb)', 'memory (gb)'] },
  { key: 'storage', label: 'Storage', aliases: ['storage', 'hdd', 'ssd', 'disk', 'drive', 'capacity'] },
  { key: 'screenSize', label: 'Screen size', aliases: ['screen', 'screen size', 'display', 'screensize'] },
  { key: 'condition', label: 'Condition', aliases: ['condition', 'cond'] },
  { key: 'grade', label: 'Grade', aliases: ['grade', 'cosmetic grade'] },
  { key: 'quantity', label: 'Quantity', aliases: ['quantity', 'qty', 'count', 'units'] },
];

const NUMERIC_KEYS = new Set<keyof ExpectedLineItemInput>(['ramGb', 'quantity']);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function autoGuess(columns: string[], aliases: string[]): string {
  const norm = columns.map((c) => ({ raw: c, n: normalize(c) }));
  for (const alias of aliases) {
    const hit = norm.find((c) => c.n === alias);
    if (hit) return hit.raw;
  }
  // looser: alias contained in the header (e.g. "RAM (GB)" contains "ram")
  for (const alias of aliases) {
    const hit = norm.find((c) => c.n.includes(alias));
    if (hit) return hit.raw;
  }
  return '';
}

function toInt(value: unknown): number | undefined {
  const n = parseInt(String(value).replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(n) ? undefined : n;
}

export function ImportExpected({ batchId, hasExisting }: { batchId: string; hasExisting: boolean }) {
  const router = useRouter();
  const [fileName, setFileName] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<keyof ExpectedLineItemInput, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setDone(null);
    setFileName(file.name);
    try {
      // Loaded on demand so SheetJS isn't in the main bundle.
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
      if (parsed.length === 0) {
        setError('That file has no data rows.');
        setColumns([]);
        setRows([]);
        return;
      }
      const cols = Object.keys(parsed[0]);
      const auto: Partial<Record<keyof ExpectedLineItemInput, string>> = {};
      for (const f of TARGET_FIELDS) {
        const g = autoGuess(cols, f.aliases);
        if (g) auto[f.key] = g;
      }
      setColumns(cols);
      setRows(parsed);
      setMapping(auto);
    } catch {
      setError('Could not read that file. Export it as .csv or .xlsx and try again.');
      setColumns([]);
      setRows([]);
    }
  }

  function buildItems(): ExpectedLineItemInput[] {
    return rows
      .map((row) => {
        const item: ExpectedLineItemInput = {};
        for (const f of TARGET_FIELDS) {
          const col = mapping[f.key];
          if (!col) continue;
          const raw = row[col];
          if (raw == null || String(raw).trim() === '') continue;
          if (NUMERIC_KEYS.has(f.key)) {
            const n = toInt(raw);
            if (n !== undefined) (item[f.key] as number) = n;
          } else {
            (item[f.key] as string) = String(raw).trim();
          }
        }
        return item;
      })
      .filter((it) => Object.keys(it).length > 0);
  }

  async function onImport() {
    const items = buildItems();
    if (items.length === 0) {
      setError('Map at least one column, then import.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await importExpectedLineItems(batchId, items);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setDone(res.count ?? items.length);
    setFileName('');
    setColumns([]);
    setRows([]);
    setMapping({});
    router.refresh();
  }

  const preview = rows.slice(0, 3);

  return (
    <div className="rounded-md border border-neutral-800 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-neutral-200">Import supplier list</div>
          <div className="text-xs text-neutral-500">
            CSV or Excel. {hasExisting ? 'Re-importing replaces the current expected list.' : ''}
          </div>
        </div>
        <label className="cursor-pointer rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900">
          Choose file
          <input type="file" accept=".csv,.xlsx,.xls" onChange={onFile} className="hidden" />
        </label>
      </div>

      {fileName && !error && columns.length > 0 && (
        <div className="mt-3 space-y-3">
          <div className="text-xs text-neutral-400">
            <span className="text-neutral-200">{fileName}</span> — {rows.length} rows. Map the
            columns:
          </div>

          <div className="grid grid-cols-2 gap-2">
            {TARGET_FIELDS.map((f) => (
              <label key={f.key} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-neutral-400">{f.label}</span>
                <select
                  value={mapping[f.key] ?? ''}
                  onChange={(e) =>
                    setMapping((m) => ({ ...m, [f.key]: e.target.value || undefined }))
                  }
                  className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-neutral-200"
                >
                  <option value="">— none —</option>
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className="overflow-x-auto rounded border border-neutral-800">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-neutral-900 text-neutral-500">
                <tr>
                  {TARGET_FIELDS.filter((f) => mapping[f.key]).map((f) => (
                    <th key={f.key} className="px-2 py-1 font-normal">
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i} className="border-t border-neutral-800">
                    {TARGET_FIELDS.filter((f) => mapping[f.key]).map((f) => (
                      <td key={f.key} className="px-2 py-1 text-neutral-300">
                        {String(row[mapping[f.key] as string] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={onImport}
            disabled={busy}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Importing…' : `Import ${rows.length} rows`}
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {done != null && (
        <p className="mt-2 text-xs text-emerald-400">Imported {done} expected line items.</p>
      )}
    </div>
  );
}
