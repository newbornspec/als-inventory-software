'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addPalletLine,
  updatePalletLine,
  deletePalletLine,
  type PalletLine,
} from '@/lib/actions/pallets';
import { money } from '@/lib/money';
import { CONDITION_GRADES, PALLET_TIERS, formatLabel } from '@/lib/asset-options';

export function PalletLines({
  palletId,
  lines,
  canManage,
}: {
  palletId: string;
  lines: PalletLine[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [variant, setVariant] = useState('');
  const [qty, setQty] = useState('');
  const [grade, setGrade] = useState('');
  const [tier, setTier] = useState('');
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch {
      setError('Couldn’t save that change. Please try again — refresh the page if it persists.');
    }
  }

  async function add() {
    if (!variant.trim()) {
      setError('Enter a variant.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await addPalletLine(
      palletId,
      variant,
      parseInt(qty || '0', 10),
      cost ? parseFloat(cost) : null,
      grade,
      tier,
    );
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setVariant('');
    setQty('');
    setGrade('');
    setTier('');
    setCost('');
    router.refresh();
  }

  // Each field saves on blur/change, carrying the line's other current values so
  // editing one field never wipes the others.
  function saveVariant(line: PalletLine, next: string) {
    if (!next.trim() || next.trim() === line.variant) return;
    void run(() =>
      updatePalletLine(palletId, line.id, next, line.quantity, line.unitCost, line.grade ?? '', line.tier ?? ''),
    );
  }
  function saveQty(line: PalletLine, next: number) {
    if (Number.isNaN(next) || next === line.quantity) return;
    void run(() =>
      updatePalletLine(palletId, line.id, line.variant, next, line.unitCost, line.grade ?? '', line.tier ?? ''),
    );
  }
  function saveGrade(line: PalletLine, next: string) {
    if (next === (line.grade ?? '')) return;
    void run(() =>
      updatePalletLine(palletId, line.id, line.variant, line.quantity, line.unitCost, next, line.tier ?? ''),
    );
  }
  function saveTier(line: PalletLine, next: string) {
    if (next === (line.tier ?? '')) return;
    void run(() =>
      updatePalletLine(palletId, line.id, line.variant, line.quantity, line.unitCost, line.grade ?? '', next),
    );
  }
  function saveCost(line: PalletLine, next: number | null) {
    if (next === line.unitCost) return;
    void run(() =>
      updatePalletLine(palletId, line.id, line.variant, line.quantity, next, line.grade ?? '', line.tier ?? ''),
    );
  }
  function remove(line: PalletLine) {
    void run(() => deletePalletLine(palletId, line.id));
  }

  const cols = canManage ? 7 : 6;

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-900 text-neutral-400">
          <tr>
            <th className="min-w-[18rem] px-3 py-2">Variant / size</th>
            <th className="w-28 px-3 py-2">Tier</th>
            <th className="w-24 px-3 py-2">Quantity</th>
            <th className="w-32 px-3 py-2">Grade</th>
            <th className="w-28 px-3 py-2">Unit cost (£)</th>
            <th className="w-24 px-3 py-2">Line total</th>
            {canManage && <th className="w-16 px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-neutral-800">
              <td className="px-3 py-2">
                {canManage ? (
                  <input
                    defaultValue={l.variant}
                    onBlur={(e) => saveVariant(l, e.target.value)}
                    className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
                  />
                ) : (
                  <span className="text-neutral-200">{l.variant}</span>
                )}
              </td>
              <td className="px-3 py-2">
                {canManage ? (
                  <select
                    defaultValue={l.tier ?? ''}
                    onChange={(e) => saveTier(l, e.target.value)}
                    className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
                  >
                    <option value="">None</option>
                    {PALLET_TIERS.map((t) => (
                      <option key={t} value={t} className="bg-neutral-900">
                        {formatLabel(t)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-neutral-400">{l.tier ? formatLabel(l.tier) : '—'}</span>
                )}
              </td>
              <td className="px-3 py-2">
                {canManage ? (
                  <input
                    type="number"
                    min={0}
                    defaultValue={l.quantity}
                    onBlur={(e) => saveQty(l, parseInt(e.target.value || '0', 10))}
                    className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
                  />
                ) : (
                  l.quantity
                )}
              </td>
              <td className="px-3 py-2">
                {canManage ? (
                  <select
                    defaultValue={l.grade ?? ''}
                    onChange={(e) => saveGrade(l, e.target.value)}
                    className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
                  >
                    <option value="">Ungraded</option>
                    {CONDITION_GRADES.map((g) => (
                      <option key={g} value={g} className="bg-neutral-900">
                        {formatLabel(g)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-neutral-400">{l.grade ? formatLabel(l.grade) : '—'}</span>
                )}
              </td>
              <td className="px-3 py-2">
                {canManage ? (
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    defaultValue={l.unitCost ?? ''}
                    placeholder="—"
                    onBlur={(e) => saveCost(l, e.target.value ? parseFloat(e.target.value) : null)}
                    className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
                  />
                ) : l.unitCost != null ? (
                  money(l.unitCost)
                ) : (
                  '—'
                )}
              </td>
              <td className="px-3 py-2 text-neutral-300">
                {l.unitCost != null ? money(l.unitCost * l.quantity) : '—'}
              </td>
              {canManage && (
                <td className="px-3 py-2">
                  <button onClick={() => remove(l)} className="text-xs text-red-400 hover:underline">
                    Remove
                  </button>
                </td>
              )}
            </tr>
          ))}
          {lines.length === 0 && (
            <tr>
              <td colSpan={cols} className="px-3 py-6 text-center text-neutral-500">
                No variants added yet.
              </td>
            </tr>
          )}
        </tbody>
        {canManage && (
          <tfoot>
            <tr className="border-t border-neutral-800 bg-neutral-900/40">
              <td className="px-3 py-2">
                <input
                  value={variant}
                  onChange={(e) => setVariant(e.target.value)}
                  placeholder="e.g. 22 inch"
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
                />
              </td>
              <td className="px-3 py-2">
                <select
                  value={tier}
                  onChange={(e) => setTier(e.target.value)}
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
                >
                  <option value="">None</option>
                  {PALLET_TIERS.map((t) => (
                    <option key={t} value={t} className="bg-neutral-900">
                      {formatLabel(t)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  min={0}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="20"
                  className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
                />
              </td>
              <td className="px-3 py-2">
                <select
                  value={grade}
                  onChange={(e) => setGrade(e.target.value)}
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
                >
                  <option value="">Ungraded</option>
                  {CONDITION_GRADES.map((g) => (
                    <option key={g} value={g} className="bg-neutral-900">
                      {formatLabel(g)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="optional"
                  className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
                />
              </td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2">
                <button
                  onClick={add}
                  disabled={busy}
                  className="rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
                >
                  {busy ? '…' : 'Add'}
                </button>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
