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

export function ImportExpected({
  batchId,
  batchNumber,
  existingLineCount,
}: {
  batchId: string;
  batchNumber: string;
  existingLineCount: number;
}) {
  const hasExisting = existingLineCount > 0;
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
    // Import is replace-on-import server-side (expected-line-items.service.ts
    // deletes the batch's lines before inserting). That destroys the supplier
    // manifest this whole page's found/missing/extra reconciliation is derived
    // from, and it was a single unguarded click — the only warning was passive
    // grey text next to the file picker, well above the button. Mis-map a column
    // and the original is unrecoverable unless the operator still has the file.
    if (
      hasExisting &&
      !window.confirm(
        `Replace the supplier manifest for ${batchNumber}?\n\n` +
          `• the ${existingLineCount} line${existingLineCount === 1 ? '' : 's'} currently recorded ` +
          `will be deleted\n` +
          `• ${items.length} line${items.length === 1 ? '' : 's'} from ${fileName || 'this file'} ` +
          `will replace them\n` +
          `• found / missing / extra will be recalculated against the new list\n\n` +
          `This cannot be undone — the old manifest is not kept.`,
      )
    )
      return;
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
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-neutral-950">Import supplier list</h3>
          <p className="mt-1 text-sm text-neutral-700">
            CSV or Excel.{' '}
            {hasExisting
              ? `This lot already has ${existingLineCount} manifest line${existingLineCount === 1 ? '' : 's'} — importing replaces them.`
              : 'Nothing has been imported for this lot yet.'}
          </p>
        </div>
        <label className="shrink-0 cursor-pointer rounded-md border border-[var(--control-border)] bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#1a6ef5]">
          Choose file
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={onFile}
            aria-label="Supplier list file, CSV or Excel"
            className="sr-only"
          />
        </label>
      </div>

      {fileName && !error && columns.length > 0 && (
        <div className="mt-3 space-y-3">
          <div className="text-sm text-neutral-700">
            <span className="font-medium text-neutral-950">{fileName}</span> — {rows.length} rows.
            Map the columns:
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {TARGET_FIELDS.map((f) => (
              <label key={f.key} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-neutral-500">{f.label}</span>
                <select
                  value={mapping[f.key] ?? ''}
                  onChange={(e) =>
                    setMapping((m) => ({ ...m, [f.key]: e.target.value || undefined }))
                  }
                  className="field-underline min-w-0 flex-1 px-1.5 py-1 text-neutral-900"
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

          <div
            role="region"
            aria-label="Preview of the file being imported"
            tabIndex={0}
            className="relative min-w-0 overflow-x-auto rounded-lg border border-neutral-200 bg-white"
          >
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Preview of the imported supplier list</caption>
              <thead className="bg-neutral-50">
                <tr>
                  {TARGET_FIELDS.filter((f) => mapping[f.key]).map((f) => (
                    <th
                      scope="col"
                      key={f.key}
                      className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500"
                    >
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i} className="border-t border-neutral-200">
                    {TARGET_FIELDS.filter((f) => mapping[f.key]).map((f) => (
                      <td key={f.key} className="px-3 py-2 text-sm text-neutral-700">
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
            className="rounded-md bg-[#1a6ef5] px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {busy
              ? 'Importing…'
              : hasExisting
                ? `Replace the manifest with ${rows.length} rows`
                : `Import ${rows.length} rows`}
          </button>
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
      {done != null && (
        <p role="status" className="mt-2 text-xs text-emerald-800">
          Imported {done} expected line items.
        </p>
      )}
    </div>
  );
}
