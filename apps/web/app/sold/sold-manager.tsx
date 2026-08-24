'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, PackageCheck, ShieldAlert } from 'lucide-react';
import {
  bulkReturnSoldAssets,
  bulkReturnSoldPalletLines,
  type SoldAsset,
  type SoldPalletLine,
} from '@/lib/actions/sold';

// The Sold archive: one row per sold line, newest first, with the pallet it
// left on and whether that pallet still exists. Everything the old grouped
// tree could do is still here — search, filters, selection, admin returns to
// the original location or a chosen one, and CSV export of a selection.
//
// Serialized devices are kept as their own section rather than mixed into the
// table: a pallet line is a QUANTITY of an anonymous variant, a device is ONE
// identified unit, and the "Pallet status" column means nothing for a device
// that was never on a pallet. The strip above the table always states how many
// there are, so they can never be silently missing.

interface Dest {
  id: string;
  label: string;
}

const TH = 'px-4 py-3 text-left text-xs font-medium text-neutral-500';
const TD = 'px-4 py-3 text-sm';
const FILTER =
  'rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 focus:border-neutral-500 focus:outline-none';

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
  const [showDates, setShowDates] = useState(false);

  const [selA, setSelA] = useState<Set<string>>(new Set());
  const [selP, setSelP] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showSerialized, setShowSerialized] = useState(false);
  const [destBatch, setDestBatch] = useState('');
  const [destPallet, setDestPallet] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const man = (a: SoldAsset) => a.manufacturer ?? a.product?.manufacturer ?? '';
  const mod = (a: SoldAsset) => a.model ?? a.product?.model ?? '';
  const dateTime = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleString('en-GB') : '—';
  // The table wants the day only — the full timestamp lives in the expanded row.
  const dateOnly = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Europe/London' }) : '—';

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
    return palletLines
      .filter((l) => {
        // Same key shape as palletOptions below, or filtering to a deleted
        // pallet would match nothing.
        if (fPallet && (l.palletId ?? `deleted:${l.palletNumber}`) !== fPallet) return false;
        if (fSoldBy && (l.soldBy?.name ?? '') !== fSoldBy) return false;
        if (fMan && (l.product?.manufacturer ?? '') !== fMan) return false;
        // A lot filter is about devices; pallet quantities have no lot, so the
        // table empties rather than pretending the filter did not apply.
        if (fBatch) return false;
        if (!inDates(l.soldAt)) return false;
        if (!needle) return true;
        return [l.variant, l.palletNumber, l.soldBy?.name].some((v) =>
          (v ?? '').toLowerCase().includes(needle),
        );
      })
      .sort((x, y) => (Date.parse(y.soldAt ?? '') || 0) - (Date.parse(x.soldAt ?? '') || 0));
  }, [palletLines, q, fPallet, fSoldBy, fMan, fBatch, from, to]);

  // Filter options come from the FULL data, so a filter can never offer a
  // value that matches nothing.
  const batchOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of assets) m.set(a.batch?.id ?? 'none', a.batch?.batchNumber ?? 'No lot');
    return [...m.entries()].sort((x, y) => y[1].localeCompare(x[1]));
  }, [assets]);
  const manOptions = useMemo(
    () =>
      [
        ...new Set(
          [...assets.map(man), ...palletLines.map((l) => l.product?.manufacturer ?? '')].filter(
            Boolean,
          ),
        ),
      ].sort(),
    [assets, palletLines],
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

  const hasFilters = Boolean(q || fBatch || fMan || fSoldBy || fPallet || from || to);
  const dispatched =
    palletLines.reduce((s, l) => s + l.quantity, 0) + assets.length;

  function toggleExpand(key: string) {
    setExpanded((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // --- bulk actions (unchanged behaviour) ---
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
    if (res.error) return setError(res.error);
    setNotice(
      `Returned ${res.returned} device${res.returned === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} skipped)` : ''}.`,
    );
    setSelA(new Set());
    router.refresh();
  }

  async function doReturnPallet(palletId?: string) {
    const ids = [...selP];
    const where = palletId
      ? palletDests.find((d) => d.id === palletId)?.label ?? 'the selected pallet'
      : 'their original pallets';
    if (!confirm(`Return ${ids.length} sold quantit${ids.length === 1 ? 'y' : 'ies'} to ${where}?`))
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await bulkReturnSoldPalletLines(ids, palletId);
    setBusy(false);
    if (res.error) return setError(res.error);
    // The reasons matter more than the count: the usual cause of a skip is
    // that the original pallet was merged, and the message names where to
    // return to instead.
    const why = res.reasons?.length ? ` ${res.reasons.join(' ')}` : '';
    setNotice(
      `Returned ${res.returned} quantit${res.returned === 1 ? 'y' : 'ies'}${res.skipped ? ` (${res.skipped} skipped)` : ''}.${why}`,
    );
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

  function exportPallet() {
    const rows = filteredPallet.filter((l) => selP.has(l.id));
    downloadCsv(
      'sold-pallet-goods.csv',
      ['Item', 'Quantity', 'Pallet', 'Pallet status', 'Date sold', 'Sold by'],
      rows.map((l) => [
        l.variant,
        String(l.quantity),
        l.palletNumber,
        l.palletId ? 'Active' : 'Deleted',
        dateTime(l.soldAt),
        l.soldBy?.name ?? '',
      ]),
    );
  }

  function exportAssets() {
    const rows = filteredAssets.filter((a) => selA.has(a.id));
    downloadCsv(
      'sold-devices.csv',
      ['Name', 'Manufacturer', 'Model', 'Serial', 'Tag', 'Lot', 'Sub-lot', 'Date sold', 'Sold by'],
      rows.map((a) => [
        a.name,
        man(a),
        mod(a),
        a.serialNumber ?? '',
        a.tag,
        a.batch?.batchNumber ?? '',
        a.lot?.lotNumber ?? '',
        dateTime(a.soldAt),
        a.soldBy?.name ?? '',
      ]),
    );
  }

  const btn =
    'rounded-md border border-[var(--control-border)] bg-white px-3 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50';

  function BulkBar({
    count,
    noun,
    dests,
    dest,
    setDest,
    onOriginal,
    onChosen,
    onExport,
    onClear,
  }: {
    count: number;
    noun: string;
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
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-[#1a6ef5] bg-blue-50 px-4 py-2.5">
        <span className="text-sm font-medium text-neutral-950">
          {count} {noun}
          {count === 1 ? '' : 's'} selected
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {isAdmin && (
            <>
              <button onClick={onOriginal} disabled={busy} className={btn}>
                Return to original
              </button>
              <select
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                aria-label={`Return ${noun}s to a chosen destination`}
                className={FILTER}
              >
                <option value="">Choose destination…</option>
                {dests.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              <button onClick={onChosen} disabled={busy || !dest} className={btn}>
                Return there
              </button>
            </>
          )}
          <button onClick={onExport} disabled={busy} className={btn}>
            Export selected (CSV)
          </button>
          <button onClick={onClear} disabled={busy} className="text-xs text-neutral-600 hover:underline">
            Clear
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6">
      {/* --- search + filters ------------------------------------------- */}
      <div className="rounded-xl border border-neutral-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="sold-search" className="sr-only">
            Search pallets, items or operator
          </label>
          <input
            id="sold-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pallets, items, or operator…"
            className={`${FILTER} min-w-0 flex-1`}
          />
          <select
            value={fBatch}
            onChange={(e) => setFBatch(e.target.value)}
            aria-label="Filter by lot"
            className={FILTER}
          >
            <option value="">All lots</option>
            {batchOptions.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={fPallet}
            onChange={(e) => setFPallet(e.target.value)}
            aria-label="Filter by pallet"
            className={FILTER}
          >
            <option value="">All pallets</option>
            {palletOptions.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={fMan}
            onChange={(e) => setFMan(e.target.value)}
            aria-label="Filter by manufacturer"
            className={FILTER}
          >
            <option value="">All manufacturers</option>
            {manOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={fSoldBy}
            onChange={(e) => setFSoldBy(e.target.value)}
            aria-label="Filter by who sold it"
            className={FILTER}
          >
            <option value="">Sold by anyone</option>
            {soldByOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {/* Date range kept from the previous page — behind a toggle so the
              bar reads as the mockup until you need it. */}
          <button
            type="button"
            onClick={() => setShowDates((v) => !v)}
            aria-expanded={showDates}
            className={FILTER + (from || to ? ' border-[#1a6ef5] text-[#1a6ef5]' : '')}
          >
            Dates{from || to ? ' •' : ''}
          </button>
          {hasFilters && (
            <button
              onClick={() => {
                setQ('');
                setFBatch('');
                setFMan('');
                setFSoldBy('');
                setFPallet('');
                setFrom('');
                setTo('');
              }}
              className="text-sm text-neutral-600 hover:underline"
            >
              Clear
            </button>
          )}
        </div>
        {showDates && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label htmlFor="sold-from" className="text-xs text-neutral-600">
              Sold from
            </label>
            <input
              id="sold-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={FILTER}
            />
            <label htmlFor="sold-to" className="text-xs text-neutral-600">
              to
            </label>
            <input
              id="sold-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={FILTER}
            />
          </div>
        )}
      </div>

      {/* --- serialized devices strip -----------------------------------
          Always states the number, so serialized stock can never be quietly
          missing from a page that claims to show what was sold. */}
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3">
        <ShieldAlert className="size-4 shrink-0 text-neutral-500" aria-hidden="true" />
        <p className="text-sm text-neutral-700">
          Serialized devices: <span className="font-medium">{filteredAssets.length} sold</span>
          {filteredAssets.length === 0 && (
            <span className="text-neutral-500"> (no serialized items match this view)</span>
          )}
        </p>
        {filteredAssets.length > 0 && (
          <button
            type="button"
            onClick={() => setShowSerialized((v) => !v)}
            aria-expanded={showSerialized}
            className="text-sm font-medium text-[#1a6ef5] hover:underline"
          >
            {showSerialized ? 'Hide devices' : 'Show devices'}
          </button>
        )}
        <span className="ml-auto text-xs text-neutral-500">
          Counted separately — a device is one identified unit, not a quantity
        </span>
      </div>

      {notice && (
        <p role="status" className="mt-3 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* --- serialized devices table (revealed from the strip) ---------- */}
      {showSerialized && filteredAssets.length > 0 && (
        <section className="mt-3">
          <BulkBar
            count={selA.size}
            noun="device"
            dests={batchDests}
            dest={destBatch}
            setDest={setDestBatch}
            onOriginal={() => doReturnAssets()}
            onChosen={() => doReturnAssets(destBatch)}
            onExport={exportAssets}
            onClear={() => setSelA(new Set())}
          />
          <div role="region" aria-label="Sold devices" tabIndex={0} className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Serialized devices that have been sold</caption>
              <thead className="border-b border-neutral-200">
                <tr>
                  <th scope="col" className={`${TH} w-10`}>
                    <span className="sr-only">Select</span>
                  </th>
                  <th scope="col" className={TH}>Unit</th>
                  <th scope="col" className={TH}>Device</th>
                  <th scope="col" className={`${TH} hidden sm:table-cell`}>Lot</th>
                  <th scope="col" className={TH}>Date sold</th>
                  <th scope="col" className={TH}>Sold by</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssets.map((a) => (
                  <tr key={a.id} className="border-b border-neutral-100 last:border-b-0">
                    <td className={TD}>
                      <input
                        type="checkbox"
                        checked={selA.has(a.id)}
                        onChange={(e) =>
                          setSelA((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(a.id);
                            else n.delete(a.id);
                            return n;
                          })
                        }
                        aria-label={`Select ${a.name}`}
                        className="size-4 accent-[#1a6ef5]"
                      />
                    </td>
                    <td className={`${TD} font-mono text-xs text-neutral-700`}>{a.tag}</td>
                    <td className={`${TD} text-neutral-900`}>
                      {[man(a), mod(a)].filter(Boolean).join(' ') || a.name}
                      {a.serialNumber && (
                        <span className="ml-2 font-mono text-xs text-neutral-500">
                          {a.serialNumber}
                        </span>
                      )}
                    </td>
                    <td className={`${TD} hidden text-neutral-600 sm:table-cell`}>
                      {a.batch?.batchNumber ?? '—'}
                    </td>
                    <td className={`${TD} text-neutral-500`}>{dateOnly(a.soldAt)}</td>
                    <td className={`${TD} text-neutral-700`}>{a.soldBy?.name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* --- the pallet archive ------------------------------------------ */}
      <section className="mt-3">
        <BulkBar
          count={selP.size}
          noun="sold quantity"
          dests={palletDests}
          dest={destPallet}
          setDest={setDestPallet}
          onOriginal={() => doReturnPallet()}
          onChosen={() => doReturnPallet(destPallet)}
          onExport={exportPallet}
          onClear={() => setSelP(new Set())}
        />

        <div role="region" aria-label="Sold pallet goods" tabIndex={0} className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">
              Pallet quantities that have been sold, newest first
            </caption>
            <thead className="border-b border-neutral-200">
              <tr>
                <th scope="col" className={TH}>Pallet / Lot ID</th>
                <th scope="col" className={TH}>Items sold details</th>
                <th scope="col" className={`${TH} text-right`}>Qty</th>
                <th scope="col" className={`${TH} hidden sm:table-cell`}>Date sold</th>
                <th scope="col" className={`${TH} hidden md:table-cell`}>Sold by</th>
                <th scope="col" className={TH}>Pallet status</th>
              </tr>
            </thead>
            <tbody>
              {filteredPallet.map((l) => {
                const open = expanded.has(l.id);
                const live = Boolean(l.palletId);
                const p = l.product;
                return (
                  <tr key={l.id} className="border-b border-neutral-100 align-top last:border-b-0">
                    <th scope="row" className={`${TD} font-normal`}>
                      <button
                        type="button"
                        onClick={() => toggleExpand(l.id)}
                        aria-expanded={open}
                        className="flex items-center gap-1.5 text-left"
                      >
                        {open ? (
                          <ChevronDown className="size-4 shrink-0 text-neutral-400" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="size-4 shrink-0 text-neutral-400" aria-hidden="true" />
                        )}
                        <span className="font-mono text-sm font-semibold text-neutral-900">
                          {l.palletNumber}
                        </span>
                      </button>
                    </th>
                    <td className={TD}>
                      <span className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={selP.has(l.id)}
                          onChange={(e) =>
                            setSelP((s) => {
                              const n = new Set(s);
                              if (e.target.checked) n.add(l.id);
                              else n.delete(l.id);
                              return n;
                            })
                          }
                          aria-label={`Select ${l.variant} from ${l.palletNumber}`}
                          className="mt-0.5 size-4 shrink-0 accent-[#1a6ef5]"
                        />
                        <span className="min-w-0">
                          <span className="block text-neutral-800">{l.variant}</span>
                          {open && (
                            <span className="mt-1 block text-xs text-neutral-500">
                              {[
                                p?.manufacturer,
                                p?.model,
                                p?.chassis,
                                p?.cpu,
                                p?.gen,
                                p?.ramGb ? `${p.ramGb}GB` : null,
                                p?.storage,
                              ]
                                .filter(Boolean)
                                .join(' · ') || 'No specification recorded for this line'}
                              <span className="mt-0.5 block">Sold {dateTime(l.soldAt)}</span>
                              {!live && (
                                <span className="mt-0.5 block">
                                  The pallet record has been deleted — this sale is kept as history.
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td className={`${TD} text-right font-semibold tabular-nums text-neutral-900`}>
                      {l.quantity}
                    </td>
                    <td className={`${TD} hidden whitespace-nowrap text-neutral-500 sm:table-cell`}>
                      {dateOnly(l.soldAt)}
                    </td>
                    <td className={`${TD} hidden md:table-cell`}>
                      <span className="flex items-center gap-2 text-neutral-700">
                        <span className="size-1.5 rounded-full bg-neutral-400" aria-hidden="true" />
                        {l.soldBy?.name ?? '—'}
                      </span>
                    </td>
                    <td className={TD}>
                      {/* Real state, not decoration: pallet_sold_lines.pallet_id
                          is ON DELETE SET NULL, so a null id means the pallet
                          record itself is gone while the sale survives. */}
                      <span
                        className={
                          'rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ' +
                          (live
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-red-50 text-red-700')
                        }
                      >
                        {live ? 'Active' : 'Deleted'}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {filteredPallet.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-neutral-500">
                    {palletLines.length === 0
                      ? 'Nothing has been sold from a pallet yet.'
                      : 'No sold pallet goods match this view.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs text-neutral-500">
          Showing {filteredPallet.length} of {palletLines.length} sold pallet line
          {palletLines.length === 1 ? '' : 's'}
          {dispatched > 0 && <> · {dispatched.toLocaleString('en-GB')} units dispatched in total</>}
          {isAdmin
            ? ' · Returns put stock back where it came from, or somewhere you choose.'
            : ' · Only an administrator can return items to inventory.'}
        </p>
      </section>
    </div>
  );
}

export function DispatchedCard({ units }: { units: number }) {
  return (
    <div className="flex shrink-0 items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3">
      <span className="rounded-lg bg-blue-50 p-2 text-[#1a6ef5]" aria-hidden="true">
        <PackageCheck className="size-5" />
      </span>
      <span>
        <span className="block text-[11px] uppercase tracking-wide text-neutral-500">
          Total units dispatched
        </span>
        <span className="block text-xl font-semibold tabular-nums text-neutral-950">
          {units.toLocaleString('en-GB')} Units
        </span>
      </span>
    </div>
  );
}
