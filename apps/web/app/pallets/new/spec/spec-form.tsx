'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPalletFromSpec, type SpecRow } from '@/lib/actions/pallets';
import type { LookupValue } from '@/lib/actions/lookups';
import type { Location } from '@/lib/data';

type Row = {
  manufacturer: string;
  model: string;
  chassis: string;
  cpu: string;
  ram: string;
  storage: string;
  quantity: string;
};
const emptyRow = (): Row => ({
  manufacturer: '',
  model: '',
  chassis: '',
  cpu: '',
  ram: '',
  storage: '',
  quantity: '',
});

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
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow(), emptyRow()]);
  const [meta, setMeta] = useState({ description: '', supplier: '', buyer: '', locationId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = useMemo(() => lookups.filter((l) => l.active), [lookups]);
  const manufacturers = useMemo(
    () => active.filter((l) => l.category === 'manufacturer'),
    [active],
  );
  const models = useMemo(() => active.filter((l) => l.category === 'model'), [active]);
  const manIdByValue = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of manufacturers) m.set(x.value.trim().toLowerCase(), x.id);
    return m;
  }, [manufacturers]);
  const optsFor = (cat: string) => active.filter((l) => l.category === cat).map((l) => l.value);

  function setCell(i: number, key: keyof Row, val: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
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

  return (
    <div className="mt-6">
      {/* Datalists power the searchable dropdowns (native combobox behaviour). */}
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

      {/* Pallet metadata */}
      <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm text-neutral-300">Description</span>
          <input
            value={meta.description}
            onChange={(e) => setMeta({ ...meta, description: e.target.value })}
            placeholder="e.g. Mixed Dell tinies"
            className={inputCls}
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm text-neutral-300">Location</span>
          <select
            value={meta.locationId}
            onChange={(e) => setMeta({ ...meta, locationId: e.target.value })}
            className={inputCls}
          >
            <option value="">Unassigned</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-sm text-neutral-300">Supplier</span>
          <input
            value={meta.supplier}
            onChange={(e) => setMeta({ ...meta, supplier: e.target.value })}
            className={inputCls}
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm text-neutral-300">Buyer</span>
          <input
            value={meta.buyer}
            onChange={(e) => setMeta({ ...meta, buyer: e.target.value })}
            className={inputCls}
          />
        </label>
      </div>

      {/* Spec table */}
      <div className="mt-6 overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              <th className="min-w-[9rem] px-3 py-2">Manufacturer</th>
              <th className="min-w-[11rem] px-3 py-2">Model</th>
              <th className="min-w-[8rem] px-3 py-2">Chassis</th>
              <th className="min-w-[12rem] px-3 py-2">CPU</th>
              <th className="min-w-[7rem] px-3 py-2">RAM</th>
              <th className="min-w-[10rem] px-3 py-2">Storage</th>
              <th className="w-24 px-3 py-2">Quantity</th>
              <th className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const manId = manIdByValue.get(r.manufacturer.trim().toLowerCase());
              return (
                <tr key={i} className="border-t border-neutral-800">
                  <td className="px-2 py-1">
                    <input list="dl-manufacturer" value={r.manufacturer} onChange={(e) => setCell(i, 'manufacturer', e.target.value)} className={cellCls} />
                  </td>
                  <td className="px-2 py-1">
                    <input list={manId ? `dl-model-${manId}` : undefined} value={r.model} onChange={(e) => setCell(i, 'model', e.target.value)} className={cellCls} />
                  </td>
                  <td className="px-2 py-1">
                    <input list="dl-chassis" value={r.chassis} onChange={(e) => setCell(i, 'chassis', e.target.value)} className={cellCls} />
                  </td>
                  <td className="px-2 py-1">
                    <input list="dl-cpu" value={r.cpu} onChange={(e) => setCell(i, 'cpu', e.target.value)} className={cellCls} />
                  </td>
                  <td className="px-2 py-1">
                    <input list="dl-ram" value={r.ram} onChange={(e) => setCell(i, 'ram', e.target.value)} className={cellCls} />
                  </td>
                  <td className="px-2 py-1">
                    <input list="dl-storage" value={r.storage} onChange={(e) => setCell(i, 'storage', e.target.value)} className={cellCls} />
                  </td>
                  <td className="px-2 py-1">
                    <input type="number" min={0} value={r.quantity} onChange={(e) => setCell(i, 'quantity', e.target.value)} className={cellCls + ' w-20'} />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <button
                      onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs))}
                      className="text-xs text-red-400 hover:underline"
                      aria-label="Remove row"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setRows((rs) => [...rs, emptyRow()])}
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900"
        >
          + Add row
        </button>
        <button
          onClick={save}
          disabled={busy}
          className="rounded-md bg-neutral-100 px-4 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save pallet'}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      <p className="mt-2 text-xs text-neutral-600">
        New values you type are saved to the dropdown lists when you save the pallet.
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
