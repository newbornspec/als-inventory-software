'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  addLookup,
  updateLookup,
  deleteLookup,
  type LookupValue,
} from '@/lib/actions/lookups';

const CATEGORIES: { key: string; label: string }[] = [
  { key: 'manufacturer', label: 'Manufacturer' },
  { key: 'model', label: 'Model' },
  { key: 'chassis', label: 'Chassis' },
  { key: 'cpu', label: 'CPU' },
  { key: 'ram', label: 'RAM' },
  { key: 'storage', label: 'Storage' },
];

export function LookupsManager({ all }: { all: LookupValue[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState('manufacturer');
  const [error, setError] = useState<string | null>(null);
  const [newValue, setNewValue] = useState('');

  const manufacturers = useMemo(
    () => all.filter((l) => l.category === 'manufacturer').sort(byValue),
    [all],
  );
  const [manufacturerId, setManufacturerId] = useState('');

  // The rows shown for the active tab. Model is scoped to a chosen manufacturer.
  const rows = useMemo(() => {
    if (tab === 'model') {
      if (!manufacturerId) return [];
      return all.filter((l) => l.category === 'model' && l.parentId === manufacturerId).sort(byValue);
    }
    return all.filter((l) => l.category === tab).sort(byValue);
  }, [all, tab, manufacturerId]);

  function run(fn: () => Promise<{ error?: string }>) {
    startTransition(async () => {
      setError(null);
      const res = await fn();
      if (res?.error) setError(res.error);
      router.refresh();
    });
  }

  function onAdd() {
    const v = newValue.trim();
    if (!v) return;
    if (tab === 'model' && !manufacturerId) {
      setError('Pick a manufacturer first.');
      return;
    }
    setNewValue('');
    run(() => addLookup(tab, v, tab === 'model' ? manufacturerId : undefined));
  }

  return (
    <div className="mt-6">
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            onClick={() => setTab(c.key)}
            className={
              'rounded-md px-3 py-1.5 text-sm ' +
              (tab === c.key
                ? 'bg-neutral-100 text-neutral-900'
                : 'border border-neutral-700 text-neutral-300 hover:bg-neutral-900')
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      {tab === 'model' && (
        <div className="mt-4 flex items-center gap-2 text-sm">
          <span className="text-neutral-400">Models for</span>
          <select
            value={manufacturerId}
            onChange={(e) => setManufacturerId(e.target.value)}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
          >
            <option value="">— Select manufacturer —</option>
            {manufacturers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.value}
                {m.active ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className={'mt-4 max-w-2xl ' + (pending ? 'opacity-60' : '')}>
        {/* Add row */}
        {(tab !== 'model' || manufacturerId) && (
          <div className="flex items-center gap-2">
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onAdd()}
              placeholder={`Add a ${tab} value…`}
              className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            />
            <button
              onClick={onAdd}
              disabled={pending}
              className="shrink-0 rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        )}

        <ul className="mt-3 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
          {rows.map((l) => (
            <li key={l.id} className="flex items-center gap-3 px-3 py-2">
              <input
                defaultValue={l.value}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next && next !== l.value) run(() => updateLookup(l.id, { value: next }));
                }}
                className={
                  'w-full rounded border border-transparent bg-transparent px-1 py-1 text-sm hover:border-neutral-700 focus:border-neutral-600 focus:outline-none ' +
                  (l.active ? 'text-neutral-100' : 'text-neutral-500 line-through')
                }
              />
              <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-400">
                <input
                  type="checkbox"
                  checked={l.active}
                  onChange={(e) => run(() => updateLookup(l.id, { active: e.target.checked }))}
                />
                Active
              </label>
              <button
                onClick={() => {
                  if (confirm(`Delete "${l.value}"?${l.category === 'manufacturer' ? ' Its models will be removed too.' : ''}`))
                    run(() => deleteLookup(l.id));
                }}
                className="shrink-0 text-xs text-red-400 hover:underline"
              >
                Delete
              </button>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-neutral-500">
              {tab === 'model' && !manufacturerId
                ? 'Select a manufacturer to manage its models.'
                : 'No values yet — add one above.'}
            </li>
          )}
        </ul>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}

function byValue(a: LookupValue, b: LookupValue) {
  return a.sortOrder - b.sortOrder || a.value.localeCompare(b.value);
}
