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
  { key: 'gen', label: 'Gen' },
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
      {/* A tablist promises Left/Right to move between tabs and one Tab stop
          for the whole set; without that it announces itself as a tab list and
          then behaves like seven separate buttons. */}
      <div
        role="tablist"
        aria-label="Lookup category"
        onKeyDown={(e) => {
          const keys = CATEGORIES.map((c) => c.key);
          const i = keys.indexOf(tab);
          let next: string | null = null;
          if (e.key === 'ArrowRight') next = keys[(i + 1) % keys.length];
          else if (e.key === 'ArrowLeft') next = keys[(i - 1 + keys.length) % keys.length];
          else if (e.key === 'Home') next = keys[0];
          else if (e.key === 'End') next = keys[keys.length - 1];
          if (!next) return;
          e.preventDefault();
          setTab(next as typeof tab);
          document.getElementById(`lookup-tab-${next}`)?.focus();
        }}
        className="flex flex-wrap gap-2"
      >
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            role="tab"
            id={`lookup-tab-${c.key}`}
            aria-selected={tab === c.key}
            aria-controls="lookup-panel"
            tabIndex={tab === c.key ? 0 : -1}
            onClick={() => setTab(c.key)}
            className={
              'rounded-md px-3 py-1.5 text-sm ' +
              (tab === c.key
                ? 'bg-neutral-100 font-semibold text-neutral-900 ring-1 ring-neutral-400'
                : 'border border-[var(--field-border)] text-neutral-700 hover:bg-white')
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      <div id="lookup-panel" role="tabpanel" aria-labelledby={`lookup-tab-${tab}`} tabIndex={0}>
      {tab === 'model' && (
        <div className="mt-4 flex items-center gap-2 text-sm">
          <label htmlFor="lookup-manufacturer" className="text-neutral-700">
            Models for
          </label>
          <select
            id="lookup-manufacturer"
            value={manufacturerId}
            onChange={(e) => setManufacturerId(e.target.value)}
            className="field-underline px-2 py-1.5 text-sm"
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

      <div aria-busy={pending} className={'mt-4 max-w-2xl ' + (pending ? 'cursor-progress' : '')}>
        {/* Add row */}
        {(tab !== 'model' || manufacturerId) && (
          <div className="flex items-center gap-2">
            <input
              aria-label="New lookup value"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onAdd()}
              placeholder={`Add a ${tab} value…`}
              className="field-underline w-full px-3 py-2 text-sm"
            />
            <button
              onClick={onAdd}
              disabled={pending}
              className="shrink-0 rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Add
            </button>
          </div>
        )}

        <ul className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
          {rows.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <input
                aria-label={`Rename ${l.value}`}
                defaultValue={l.value}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next && next !== l.value) run(() => updateLookup(l.id, { value: next }));
                }}
                className={
                  'field-inline w-full px-1 py-1 text-sm ' +
                  (l.active ? 'text-neutral-950' : 'text-neutral-500 line-through')
                }
              />
              <label className="flex shrink-0 items-center gap-1 text-xs text-neutral-500">
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
                aria-label={`Delete ${l.value}`}
                className="shrink-0 text-xs text-red-700 hover:underline"
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
        {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
      </div>
      </div>
    </div>
  );
}

function byValue(a: LookupValue, b: LookupValue) {
  return a.sortOrder - b.sortOrder || a.value.localeCompare(b.value);
}
