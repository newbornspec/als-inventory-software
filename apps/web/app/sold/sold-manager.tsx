'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  bulkReturnSoldAssets,
  bulkReturnSoldPalletLines,
  type SoldAsset,
  type SoldPalletLine,
} from '@/lib/actions/sold';

// The Sold page as a structured module, not a flat archive: sold devices are
// grouped Batch → Sub-lot (mirroring the app's hierarchy), pallet goods by
// pallet; groups expand/collapse; rows are checkbox-selectable for bulk
// actions — admin returns (to the original location by default, or a chosen
// destination) and CSV export.

interface Dest {
  id: string;
  label: string;
}

const cellCls = 'px-3 py-2';
const filterCls =
  'rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm focus:border-neutral-300';

export function SoldManager({
  assets,
  palletLines,
  batchDests,
  palletDests,
  isAdmin,
}: {
  assets: SoldAsset[];
  palletLines: SoldPalletLine[];
  batchDests: Dest[];
  palletDests: Dest[];
  isAdmin: boolean;
}) {
  const router = useRouter();

  // --- filters (client-side; the data is already loaded) ---
  const [q, setQ] = useState('');
  const [fBatch, setFBatch] = useState('');
  const [fMan, setFMan] = useState('');
  const [fSoldBy, setFSoldBy] = useState('');
  const [fPallet, setFPallet] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // --- selection + tree state ---
  const [selA, setSelA] = useState<Set<string>>(new Set());
  const [selP, setSelP] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [destBatch, setDestBatch] = useState('');
  const [destPallet, setDestPallet] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const man = (a: SoldAsset) => a.manufacturer ?? a.product?.manufacturer ?? '';
  const mod = (a: SoldAsset) => a.model ?? a.product?.model ?? '';
  const date = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('en-GB') : '—');

  const inDates = (d: string | null | undefined) => {
    if (!from && !to) return true;
    if (!d) return false;
    const t = new Date(d).getTime();
    if (from && t < new Date(from).getTime()) return false;
    if (to && t > new Date(`${to}T23:59:59`).getTime()) return false;
    return true;
  };

  const filteredAssets = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return assets.filter((a) => {
      if (fBatch && (a.batch?.id ?? 'none') !== fBatch) return false;
      if (fMan && man(a) !== fMan) return false;
      if (fSoldBy && (a.soldBy?.name ?? '') !== fSoldBy) return false;
      if (!inDates(a.soldAt)) return false;
      if (!needle) return true;
      return [a.name, a.tag, a.serialNumber, man(a), mod(a), a.batch?.batchNumber, a.lot?.lotNumber]
        .some((v) => (v ?? '').toLowerCase().includes(needle));
    });
  }, [assets, q, fBatch, fMan, fSoldBy, from, to]);

  const filteredPallet = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return palletLines.filter((l) => {
      // Same key shape as palletOptions below, or filtering to a deleted
      // pallet would match nothing.
      if (fPallet && (l.palletId ?? `deleted:${l.palletNumber}`) !== fPallet) return false;
      if (fSoldBy && (l.soldBy?.name ?? '') !== fSoldBy) return false;
      if (!inDates(l.soldAt)) return false;
      if (!needle) return true;
      return [l.variant, l.palletNumber].some((v) => (v ?? '').toLowerCase().includes(needle));
    });
  }, [palletLines, q, fPallet, fSoldBy, from, to]);

  // --- grouping: Batch → Sub-lot → devices ---
  const assetGroups = useMemo(() => {
    const byBatch = new Map<string, { label: string; lots: Map<string, { label: string; items: SoldAsset[] }> }>();
    for (const a of filteredAssets) {
      const bKey = a.batch?.id ?? 'none';
      const bLabel = a.batch?.batchNumber ?? 'No lot';
      if (!byBatch.has(bKey)) byBatch.set(bKey, { label: bLabel, lots: new Map() });
      const g = byBatch.get(bKey)!;
      const lKey = a.lot?.id ?? 'none';
      const lLabel = a.lot?.lotNumber ?? 'No sub-lot';
      if (!g.lots.has(lKey)) g.lots.set(lKey, { label: lLabel, items: [] });
      g.lots.get(lKey)!.items.push(a);
    }
    return [...byBatch.entries()]
      .map(([key, g]) => ({
        key,
        label: g.label,
        count: [...g.lots.values()].reduce((s, l) => s + l.items.length, 0),
        lots: [...g.lots.entries()]
          .map(([lk, l]) => ({ key: `${key}|${lk}`, label: l.label, items: l.items }))
          .sort((x, y) => x.label.localeCompare(y.label)),
      }))
      .sort((x, y) => y.label.localeCompare(x.label));
  }, [filteredAssets]);

  const palletGroups = useMemo(() => {
    const byPallet = new Map<string, { label: string; items: SoldPalletLine[]; last: number }>();
    for (const l of filteredPallet) {
      // Namespace the fallback key. pallet_sold_lines.pallet_id is ON DELETE SET
      // NULL, so a deleted pallet's rows survive with only their number — and
      // numbers are typed by the operator now, so one can legitimately be reused.
      // Keying a live pallet on a bare number would merge the dead pallet's
      // history into it.
      const key = l.palletId ?? `deleted:${l.palletNumber}`;
      const label = l.palletNumber + (l.palletId ? '' : ' (pallet deleted)');
      const at = Date.parse(l.soldAt ?? '') || 0;
      if (!byPallet.has(key)) byPallet.set(key, { label, items: [], last: at });
      const g = byPallet.get(key)!;
      g.items.push(l);
      if (at > g.last) g.last = at;
    }
    return [...byPallet.entries()]
      .map(([key, g]) => ({
        key: `p:${key}`,
        label: g.label,
        units: g.items.reduce((s, x) => s + x.quantity, 0),
        items: g.items,
        last: g.last,
      }))
      // Most recently sold first. Sorting on the label was only chronological
      // because generated numbers were zero-padded; with typed numbers "10"
      // sorts before "9".
      .sort((x, y) => y.last - x.last);
  }, [filteredPallet]);

  // Filter dropdown options come from the full (unfiltered) data.
  const batchOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of assets) m.set(a.batch?.id ?? 'none', a.batch?.batchNumber ?? 'No lot');
    return [...m.entries()].sort((x, y) => y[1].localeCompare(x[1]));
  }, [assets]);
  const manOptions = useMemo(
    () => [...new Set(assets.map(man).filter(Boolean))].sort(),
    [assets],
  );
  const soldByOptions = useMemo(
    () =>
      [...new Set([...assets, ...palletLines].map((x) => x.soldBy?.name ?? '').filter(Boolean))].sort(),
    [assets, palletLines],
  );
  const palletOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of palletLines) m.set(l.palletId ?? `deleted:${l.palletNumber}`, l.palletNumber);
    return [...m.entries()].sort((x, y) => y[1].localeCompare(x[1]));
  }, [palletLines]);

  const hasFilters = q || fBatch || fMan || fSoldBy || fPallet || from || to;

  // --- selection helpers ---
  const toggleIn = (set: Set<string>, ids: string[], on: boolean) => {
    const next = new Set(set);
    for (const id of ids) (on ? next.add(id) : next.delete(id));
    return next;
  };
  const allIn = (set: Set<string>, ids: string[]) => ids.length > 0 && ids.every((id) => set.has(id));

  function toggleCollapse(key: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // --- bulk actions ---
  async function doReturnAssets(batchId?: string) {
    const ids = [...selA];
    const where = batchId
      ? batchDests.find((d) => d.id === batchId)?.label ?? 'the selected lot'
      : 'their original lots';
    if (!confirm(`Return ${ids.length} device${ids.length === 1 ? '' : 's'} to ${where}?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await bulkReturnSoldAssets(ids, batchId);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setNotice(`Returned ${res.returned} device${res.returned === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} skipped)` : ''}.`);
    setSelA(new Set());
    router.refresh();
  }

  async function doReturnPallet(palletId?: string) {
    const ids = [...selP];
    const where = palletId
      ? palletDests.find((d) => d.id === palletId)?.label ?? 'the selected pallet'
      : 'their original pallets';
    if (!confirm(`Return ${ids.length} sold quantit${ids.length === 1 ? 'y' : 'ies'} to ${where}?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await bulkReturnSoldPalletLines(ids, palletId);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setNotice(`Returned ${res.returned} quantit${res.returned === 1 ? 'y' : 'ies'}${res.skipped ? ` (${res.skipped} skipped)` : ''}.`);
    setSelP(new Set());
    router.refresh();
  }

  function downloadCsv(filename: string, header: string[], lines: string[][]) {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [header, ...lines].map((row) => row.map(esc).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    a.download = filename;
    a.click();
  }

  function exportAssets() {
    const rows = filteredAssets.filter((a) => selA.has(a.id));
    downloadCsv(
      'sold-devices.csv',
      ['Name', 'Manufacturer', 'Model', 'Serial', 'Tag', 'Lot', 'Sub-lot', 'Date sold', 'Sold by'],
      rows.map((a) => [
        a.name, man(a), mod(a), a.serialNumber ?? '', a.tag,
        a.batch?.batchNumber ?? '', a.lot?.lotNumber ?? '', date(a.soldAt), a.soldBy?.name ?? '',
      ]),
    );
  }

  function exportPallet() {
    const rows = filteredPallet.filter((l) => selP.has(l.id));
    downloadCsv(
      'sold-pallet-goods.csv',
      ['Item', 'Quantity', 'Pallet', 'Date sold', 'Sold by'],
      rows.map((l) => [l.variant, String(l.quantity), l.palletNumber, date(l.soldAt), l.soldBy?.name ?? '']),
    );
  }

  const chk = 'h-4 w-4 accent-emerald-600';
  const btn =
    'rounded-md border border-[var(--field-border)] px-2.5 py-1 text-xs text-neutral-900 hover:bg-neutral-100 disabled:opacity-50';

  function BulkBar({
    count,
    dests,
    dest,
    setDest,
    onOriginal,
    onChosen,
    onExport,
    onClear,
  }: {
    count: number;
    dests: Dest[];
    dest: string;
    setDest: (v: string) => void;
    onOriginal: () => void;
    onChosen: () => void;
    onExport: () => void;
    onClear: () => void;
  }) {
    if (count === 0) return null;
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
        <span className="text-xs font-medium text-neutral-900">{count} selected</span>
        {isAdmin && (
          <>
            <button onClick={onOriginal} disabled={busy} className={btn}>
              {busy ? 'Working…' : 'Return to original location'}
            </button>
            <span className="flex items-center gap-1">
              <select aria-label="Return destination" value={dest} onChange={(e) => setDest(e.target.value)} className={filterCls + ' py-1 text-xs'}>
                <option value="">— other destination —</option>
                {dests.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
              <button onClick={onChosen} disabled={busy || !dest} className={btn}>
                Return there
              </button>
            </span>
          </>
        )}
        <button onClick={onExport} disabled={busy} className={btn}>
          Export selected (CSV)
        </button>
        <button onClick={onClear} disabled={busy} className="text-xs text-neutral-500 hover:text-neutral-700">
          Clear
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Search sold items"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tag, serial, name, make, model, lot…"
          className={filterCls + ' w-full min-w-0 flex-1 sm:w-auto sm:min-w-[16rem]'}
        />
        <select aria-label="Filter by lot" value={fBatch} onChange={(e) => setFBatch(e.target.value)} className={filterCls}>
          <option value="">All lots</option>
          {batchOptions.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
        <select aria-label="Filter by pallet" value={fPallet} onChange={(e) => setFPallet(e.target.value)} className={filterCls}>
          <option value="">All pallets</option>
          {palletOptions.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
        <select aria-label="Filter by manufacturer" value={fMan} onChange={(e) => setFMan(e.target.value)} className={filterCls}>
          <option value="">All manufacturers</option>
          {manOptions.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select aria-label="Filter by who sold it" value={fSoldBy} onChange={(e) => setFSoldBy(e.target.value)} className={filterCls}>
          <option value="">Sold by anyone</option>
          {soldByOptions.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          from <input type="date" aria-label="Sold from date" value={from} onChange={(e) => setFrom(e.target.value)} className={filterCls} />
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          to <input type="date" aria-label="Sold to date" value={to} onChange={(e) => setTo(e.target.value)} className={filterCls} />
        </label>
        {hasFilters && (
          <button
            onClick={() => { setQ(''); setFBatch(''); setFMan(''); setFSoldBy(''); setFPallet(''); setFrom(''); setTo(''); }}
            className="text-xs text-neutral-500 hover:text-neutral-700"
          >
            Clear filters
          </button>
        )}
      </div>

      {(notice || error) && (
        <p
          role={error ? 'alert' : 'status'}
          className={`mt-3 text-sm ${error ? 'text-red-700' : 'text-emerald-800'}`}
        >
          {error ?? notice}
        </p>
      )}

      {/* ============ Serialized devices: Batch → Sub-lot → device ============ */}
      <section className="mt-6">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium text-neutral-700">
            <input
              type="checkbox"
              className={chk}
              checked={allIn(selA, filteredAssets.map((a) => a.id))}
              onChange={(e) => setSelA(toggleIn(selA, filteredAssets.map((a) => a.id), e.target.checked))}
              aria-label="Select all devices"
            />
          </label>
          <h2 className="text-sm font-medium text-neutral-800">Serialized devices</h2>
          <span className="text-sm text-neutral-500">
            {filteredAssets.length}{hasFilters ? ` of ${assets.length}` : ''} sold
          </span>
        </div>

        <BulkBar
          count={selA.size}
          dests={batchDests}
          dest={destBatch}
          setDest={setDestBatch}
          onOriginal={() => void doReturnAssets()}
          onChosen={() => void doReturnAssets(destBatch)}
          onExport={exportAssets}
          onClear={() => setSelA(new Set())}
        />

        <div className="mt-3 space-y-3">
          {assetGroups.map((g) => {
            const gIds = g.lots.flatMap((l) => l.items.map((a) => a.id));
            const open = !collapsed.has(g.key);
            return (
              <div key={g.key} className="rounded-lg border border-neutral-200">
                <div className="flex items-center gap-2 bg-white px-3 py-2">
                  <button
                    onClick={() => toggleCollapse(g.key)}
                    aria-expanded={open}
                    aria-label={`${open ? 'Collapse' : 'Expand'} ${g.label}`}
                    className="w-5 text-neutral-600 hover:text-neutral-900"
                  >
                    <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                  </button>
                  <input
                    type="checkbox"
                    className={chk}
                    checked={allIn(selA, gIds)}
                    onChange={(e) => setSelA(toggleIn(selA, gIds, e.target.checked))}
                    aria-label={`Select all in ${g.label}`}
                  />
                  <h3 className="font-medium text-neutral-950">{g.label}</h3>
                  <span className="text-xs text-neutral-500">
                    {g.count} item{g.count === 1 ? '' : 's'} sold
                  </span>
                </div>

                {open &&
                  g.lots.map((l) => {
                    const lIds = l.items.map((a) => a.id);
                    const lOpen = !collapsed.has(l.key);
                    return (
                      <div key={l.key} className="border-t border-neutral-200">
                        <div className="flex items-center gap-2 px-3 py-1.5 pl-8">
                          <button
                            onClick={() => toggleCollapse(l.key)}
                            aria-expanded={lOpen}
                            aria-label={`${lOpen ? 'Collapse' : 'Expand'} ${l.label}`}
                            className="w-5 text-neutral-600 hover:text-neutral-900"
                          >
                            <span aria-hidden="true">{lOpen ? '▾' : '▸'}</span>
                          </button>
                          <input
                            type="checkbox"
                            className={chk}
                            checked={allIn(selA, lIds)}
                            onChange={(e) => setSelA(toggleIn(selA, lIds, e.target.checked))}
                            aria-label={`Select all in ${l.label}`}
                          />
                          <span className="text-sm text-neutral-700">{l.label}</span>
                          <span className="text-xs text-neutral-500">{l.items.length} item{l.items.length === 1 ? '' : 's'}</span>
                        </div>
                        {lOpen && (
                          <div role="region" aria-label="Sold devices by lot" tabIndex={0} className="overflow-x-auto">
                            <table className="w-full text-left text-xs">
                      <caption className="sr-only">
                        Sold pallet lines with quantity, sale price and who sold them
                      </caption>
                              <caption className="sr-only">
                                Sold devices with tag, specification, sale price and who sold them
                              </caption>
                              <thead className="text-neutral-500">
                                <tr>
                                  <th scope="col" className="w-10 px-3 py-1.5" />
                                  <th scope="col" className={cellCls}>Name</th>
                                  <th scope="col" className={cellCls}>Manufacturer</th>
                                  <th scope="col" className={cellCls}>Model</th>
                                  <th scope="col" className={cellCls}>Serial</th>
                                  <th scope="col" className={cellCls}>Tag</th>
                                  <th scope="col" className={cellCls}>Date sold</th>
                                  <th scope="col" className={cellCls}>Sold by</th>
                                </tr>
                              </thead>
                              <tbody>
                                {l.items.map((a) => (
                                  <tr key={a.id} className="border-t border-neutral-200 hover:bg-neutral-50">
                                    <td className="px-3 py-1.5 pl-12">
                                      <input
                                        type="checkbox"
                                        className={chk}
                                        checked={selA.has(a.id)}
                                        onChange={(e) => setSelA(toggleIn(selA, [a.id], e.target.checked))}
                                        aria-label={`Select ${a.name}`}
                                      />
                                    </td>
                                    <td className={`${cellCls} text-neutral-950`}>{a.name}</td>
                                    <td className={`${cellCls} text-neutral-500`}>{man(a) || '—'}</td>
                                    <td className={`${cellCls} text-neutral-500`}>{mod(a) || '—'}</td>
                                    <td className={`${cellCls} text-neutral-500`}>{a.serialNumber ?? '—'}</td>
                                    <td className={`${cellCls} text-neutral-500`}>{a.tag}</td>
                                    <td className={`${cellCls} text-neutral-500`}>{date(a.soldAt)}</td>
                                    <td className={`${cellCls} text-neutral-500`}>{a.soldBy?.name ?? '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            );
          })}
          {assetGroups.length === 0 && (
            <p className="rounded-lg border border-[var(--field-border)] px-4 py-6 text-center text-sm text-neutral-500">
              {hasFilters ? 'No sold devices match the filters.' : 'No sold devices yet.'}
            </p>
          )}
        </div>
      </section>

      {/* ============ Pallet goods: grouped by pallet ============ */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium text-neutral-700">
            <input
              type="checkbox"
              className={chk}
              checked={allIn(selP, filteredPallet.map((l) => l.id))}
              onChange={(e) => setSelP(toggleIn(selP, filteredPallet.map((l) => l.id), e.target.checked))}
              aria-label="Select all pallet goods"
            />
          </label>
          <h2 className="text-sm font-medium text-neutral-800">Pallet goods</h2>
          <span className="text-sm text-neutral-500">
            {filteredPallet.reduce((s, l) => s + l.quantity, 0)} units
            {hasFilters ? ` shown of ${palletLines.reduce((s, l) => s + l.quantity, 0)}` : ''}
          </span>
        </div>

        <BulkBar
          count={selP.size}
          dests={palletDests}
          dest={destPallet}
          setDest={setDestPallet}
          onOriginal={() => void doReturnPallet()}
          onChosen={() => void doReturnPallet(destPallet)}
          onExport={exportPallet}
          onClear={() => setSelP(new Set())}
        />

        <div className="mt-3 space-y-3">
          {palletGroups.map((g) => {
            const gIds = g.items.map((x) => x.id);
            const open = !collapsed.has(g.key);
            return (
              <div key={g.key} className="rounded-lg border border-neutral-200">
                <div className="flex items-center gap-2 bg-white px-3 py-2">
                  <button
                    onClick={() => toggleCollapse(g.key)}
                    aria-expanded={open}
                    aria-label={`${open ? 'Collapse' : 'Expand'} ${g.label}`}
                    className="w-5 text-neutral-600 hover:text-neutral-900"
                  >
                    <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                  </button>
                  <input
                    type="checkbox"
                    className={chk}
                    checked={allIn(selP, gIds)}
                    onChange={(e) => setSelP(toggleIn(selP, gIds, e.target.checked))}
                    aria-label={`Select all from ${g.label}`}
                  />
                  <h3 className="font-medium text-neutral-950">{g.label}</h3>
                  <span className="text-xs text-neutral-500">
                    {g.units} unit{g.units === 1 ? '' : 's'} · {g.items.length} row{g.items.length === 1 ? '' : 's'}
                  </span>
                </div>
                {open && (
                  <div role="region" aria-label="Sold pallet lines" tabIndex={0} className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-neutral-500">
                        <tr>
                          <th scope="col" className="w-10 px-3 py-1.5" />
                          <th scope="col" className={cellCls}>Item</th>
                          <th scope="col" className={cellCls}>Qty</th>
                          <th scope="col" className={cellCls}>Date sold</th>
                          <th scope="col" className={cellCls}>Sold by</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map((l) => (
                          <tr key={l.id} className="border-t border-neutral-200 hover:bg-neutral-50">
                            <td className="px-3 py-1.5 pl-8">
                              <input
                                type="checkbox"
                                className={chk}
                                checked={selP.has(l.id)}
                                onChange={(e) => setSelP(toggleIn(selP, [l.id], e.target.checked))}
                                aria-label={`Select ${l.variant}`}
                              />
                            </td>
                            <td className={`${cellCls} text-neutral-950`}>{l.variant}</td>
                            <td className={`${cellCls} font-medium tabular-nums`}>{l.quantity}</td>
                            <td className={`${cellCls} text-neutral-500`}>{date(l.soldAt)}</td>
                            <td className={`${cellCls} text-neutral-500`}>{l.soldBy?.name ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
          {palletGroups.length === 0 && (
            <p className="rounded-lg border border-[var(--field-border)] px-4 py-6 text-center text-sm text-neutral-500">
              {hasFilters ? 'No sold pallet goods match the filters.' : 'No sold pallet goods yet.'}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
