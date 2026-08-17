'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addPalletLine,
  updatePalletLine,
  deletePalletLine,
  type PalletLine,
  type PalletLinePatch,
} from '@/lib/actions/pallets';
import type { LookupValue } from '@/lib/actions/lookups';
import { sellPalletLine } from '@/lib/actions/sold';
import { money } from '@/lib/money';
import {
  PALLET_LINE_GRADES,
  PALLET_MANUFACTURERS,
  PALLET_VARIANT_TYPES,
  formatLabel,
} from '@/lib/asset-options';

// One row per product/variant combination, matching the sheet the warehouse
// keeps by hand: Manufacturer · Model · Size · Variant · Stand · Qty · Grade ·
// Unit cost. The pallet number is not a column here — it is the page heading,
// and it is written onto every row of the Excel export.
//
// No line total on screen by request. Quantity x unit cost is still computed in
// the Excel export, which is where it is actually used.

export function PalletLines({
  palletId,
  lines,
  canManage,
  lookups = [],
}: {
  palletId: string;
  lines: PalletLine[];
  canManage: boolean;
  lookups?: LookupValue[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The new-row form.
  const [add, setAdd] = useState<PalletLinePatch>({});

  // Sizes stay admin-managed at /lookups; manufacturers are a fixed list.
  const sizes = useMemo(
    () => lookups.filter((l) => l.category === 'size' && l.active),
    [lookups],
  );

  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch {
      setError('Couldn’t save that change. Please try again — refresh the page if it persists.');
    }
  }

  // Send ONLY what changed; the API recomposes the row's label from the merged
  // record, so a partial patch cannot blank the fields left alone.
  function save(line: PalletLine, patch: PalletLinePatch) {
    void run(() => updatePalletLine(palletId, line.id, patch));
  }

  async function addRow() {
    const hasSomething =
      (add.manufacturer ?? '').trim() ||
      (add.model ?? '').trim() ||
      (add.size ?? '').trim() ||
      (add.quantity ?? 0) > 0;
    if (!hasSomething) {
      setError('Fill in at least a manufacturer, model, size or quantity.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await addPalletLine(palletId, add);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setAdd({});
    router.refresh();
  }

  function remove(line: PalletLine) {
    void run(() => deletePalletLine(palletId, line.id));
  }

  // Sell all or part of this line's quantity — it moves to the Sold page and
  // the pallet total shrinks. Prompt defaults to the full quantity.
  async function sell(line: PalletLine) {
    const raw = window.prompt(
      `Sell how many of "${line.variant}"? (1–${line.quantity})`,
      String(line.quantity),
    );
    if (raw === null) return;
    const qty = Math.min(Math.max(1, parseInt(raw, 10) || 0), line.quantity);
    const priceRaw = window.prompt(
      `Total sale price for the ${qty} unit${qty === 1 ? '' : 's'} £ (optional — leave blank to skip)`,
      '',
    );
    const salePrice =
      priceRaw && !isNaN(parseFloat(priceRaw)) ? Math.max(0, parseFloat(priceRaw)) : undefined;
    setError(null);
    const res = await sellPalletLine(palletId, line.id, qty, salePrice);
    if (res.error) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  const totalUnits = lines.reduce((sum, l) => sum + l.quantity, 0);

  const field = 'w-full rounded border border-neutral-200 bg-white px-2 py-1.5';
  const cols = canManage ? 9 : 8;

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
      {/* min-w matters: w-* on a th is only a hint, and inside overflow-x-auto a
          w-full table compresses to its container instead of holding its
          columns — which squeezed "Frameless" to "Fram" and "Grade B" to "Gra".
          A floor plus the existing horizontal scroll keeps every control
          readable at any width. */}
      <table className="w-full min-w-[64rem] table-fixed text-left text-sm">
        <thead className="bg-neutral-50 text-neutral-500">
          <tr>
            <th className="w-[8.5rem] px-3 py-2">Manufacturer</th>
            <th className="w-[11rem] px-3 py-2">Model</th>
            <th className="w-[6rem] px-3 py-2">Size</th>
            <th className="w-[7.5rem] px-3 py-2">Variant</th>
            <th className="w-[5.5rem] px-3 py-2">Stand</th>
            <th className="w-[6rem] px-3 py-2">Quantity</th>
            <th className="w-[7.5rem] px-3 py-2">Grade</th>
            <th className="w-[7.5rem] px-3 py-2">Unit cost (£)</th>
            {canManage && <th className="w-[6.5rem] px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            // A row may hold a value the current dropdown no longer offers — an
            // older grade like for_parts, or a manufacturer dropped from the
            // list. Append it, or the select renders blank and the next change
            // saves that blank over real data.
            const grades =
              l.grade && !PALLET_LINE_GRADES.includes(l.grade)
                ? [...PALLET_LINE_GRADES, l.grade]
                : PALLET_LINE_GRADES;
            const makers =
              l.manufacturer && !PALLET_MANUFACTURERS.includes(l.manufacturer)
                ? [...PALLET_MANUFACTURERS, l.manufacturer]
                : PALLET_MANUFACTURERS;
            return (
              <tr key={l.id} className="border-t border-neutral-200">
                <td className="px-3 py-2">
                  {canManage ? (
                    <select
                      defaultValue={l.manufacturer ?? ''}
                      onChange={(e) => save(l, { manufacturer: e.target.value })}
                      className={field}
                    >
                      <option value="">—</option>
                      {makers.map((m) => (
                        <option key={m} value={m} className="bg-white">
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-neutral-900">{l.manufacturer ?? '—'}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {canManage ? (
                    <input
                      defaultValue={l.model ?? ''}
                      placeholder="—"
                      onBlur={(e) => save(l, { model: e.target.value })}
                      className={field}
                    />
                  ) : (
                    <span className="text-neutral-700">{l.model ?? '—'}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {canManage ? (
                    <select
                      defaultValue={l.size ?? ''}
                      onChange={(e) => save(l, { size: e.target.value })}
                      className={field}
                    >
                      <option value="">—</option>
                      {sizeOptions(sizes, l.size).map((s) => (
                        <option key={s} value={s} className="bg-white">
                          {s}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-neutral-700">{l.size ?? '—'}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {canManage ? (
                    <select
                      defaultValue={l.variantType ?? ''}
                      onChange={(e) => save(l, { variantType: e.target.value })}
                      className={field}
                    >
                      <option value="">—</option>
                      {PALLET_VARIANT_TYPES.map((v) => (
                        <option key={v} value={v} className="bg-white">
                          {formatLabel(v)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-neutral-700">
                      {l.variantType ? formatLabel(l.variantType) : '—'}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {canManage ? (
                    <select
                      defaultValue={l.stand == null ? '' : l.stand ? 'yes' : 'no'}
                      onChange={(e) =>
                        save(l, {
                          stand: e.target.value === '' ? null : e.target.value === 'yes',
                        })
                      }
                      className={field}
                    >
                      <option value="">—</option>
                      <option value="yes" className="bg-white">
                        Yes
                      </option>
                      <option value="no" className="bg-white">
                        No
                      </option>
                    </select>
                  ) : (
                    <span className="text-neutral-700">
                      {l.stand == null ? '—' : l.stand ? 'Yes' : 'No'}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {canManage ? (
                    <input
                      type="number"
                      min={0}
                      defaultValue={l.quantity}
                      onBlur={(e) => save(l, { quantity: parseInt(e.target.value || '0', 10) })}
                      className={field}
                    />
                  ) : (
                    l.quantity
                  )}
                </td>
                <td className="px-3 py-2">
                  {canManage ? (
                    <select
                      defaultValue={l.grade ?? ''}
                      onChange={(e) => save(l, { grade: e.target.value })}
                      className={field}
                    >
                      <option value="">Ungraded</option>
                      {grades.map((g) => (
                        <option key={g} value={g} className="bg-white">
                          {formatLabel(g)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-neutral-500">{l.grade ? formatLabel(l.grade) : '—'}</span>
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
                      onBlur={(e) =>
                        save(l, { unitCost: e.target.value ? parseFloat(e.target.value) : null })
                      }
                      className={field}
                    />
                  ) : l.unitCost != null ? (
                    money(l.unitCost)
                  ) : (
                    '—'
                  )}
                </td>
                {canManage && (
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {l.quantity > 0 && (
                        <button
                          onClick={() => void sell(l)}
                          className="text-xs text-emerald-700 hover:underline"
                        >
                          Sell…
                        </button>
                      )}
                      <button
                        onClick={() => remove(l)}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
          {lines.length === 0 && (
            <tr>
              <td colSpan={cols} className="px-3 py-6 text-center text-neutral-500">
                No items added yet.
              </td>
            </tr>
          )}
        </tbody>

        {canManage && (
          <tfoot>
            <tr className="border-t border-neutral-200 bg-neutral-50">
              <td className="px-3 py-2">
                <select
                  value={add.manufacturer ?? ''}
                  onChange={(e) => setAdd((a) => ({ ...a, manufacturer: e.target.value }))}
                  className={field}
                >
                  <option value="">—</option>
                  {PALLET_MANUFACTURERS.map((m) => (
                    <option key={m} value={m} className="bg-white">
                      {m}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2">
                <input
                  value={add.model ?? ''}
                  onChange={(e) => setAdd((a) => ({ ...a, model: e.target.value }))}
                  placeholder="e.g. P2419H"
                  className={field}
                />
              </td>
              <td className="px-3 py-2">
                <select
                  value={add.size ?? ''}
                  onChange={(e) => setAdd((a) => ({ ...a, size: e.target.value }))}
                  className={field}
                >
                  <option value="">—</option>
                  {sizes.map((s) => (
                    <option key={s.id} value={s.value} className="bg-white">
                      {s.value}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2">
                <select
                  value={add.variantType ?? ''}
                  onChange={(e) => setAdd((a) => ({ ...a, variantType: e.target.value }))}
                  className={field}
                >
                  <option value="">—</option>
                  {PALLET_VARIANT_TYPES.map((v) => (
                    <option key={v} value={v} className="bg-white">
                      {formatLabel(v)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2">
                <select
                  value={add.stand == null ? '' : add.stand ? 'yes' : 'no'}
                  onChange={(e) =>
                    setAdd((a) => ({
                      ...a,
                      stand: e.target.value === '' ? null : e.target.value === 'yes',
                    }))
                  }
                  className={field}
                >
                  <option value="">—</option>
                  <option value="yes" className="bg-white">
                    Yes
                  </option>
                  <option value="no" className="bg-white">
                    No
                  </option>
                </select>
              </td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  min={0}
                  value={add.quantity ?? ''}
                  onChange={(e) =>
                    setAdd((a) => ({
                      ...a,
                      quantity: e.target.value ? parseInt(e.target.value, 10) : undefined,
                    }))
                  }
                  placeholder="20"
                  className={field}
                />
              </td>
              <td className="px-3 py-2">
                <select
                  value={add.grade ?? ''}
                  onChange={(e) => setAdd((a) => ({ ...a, grade: e.target.value }))}
                  className={field}
                >
                  <option value="">Ungraded</option>
                  {PALLET_LINE_GRADES.map((g) => (
                    <option key={g} value={g} className="bg-white">
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
                  value={add.unitCost ?? ''}
                  onChange={(e) =>
                    setAdd((a) => ({
                      ...a,
                      unitCost: e.target.value ? parseFloat(e.target.value) : null,
                    }))
                  }
                  placeholder="optional"
                  className={field}
                />
              </td>
              <td className="px-3 py-2">
                <button
                  onClick={addRow}
                  disabled={busy}
                  className="rounded bg-[#2b7fff] px-2 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                >
                  {busy ? '…' : 'Add'}
                </button>
              </td>
            </tr>
            {lines.length > 0 && (
              <tr className="border-t border-neutral-200 bg-white font-medium text-neutral-900">
                <td className="px-3 py-2" colSpan={5}>
                  Total
                </td>
                <td className="px-3 py-2">{totalUnits}</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2" />
                <td className="px-3 py-2" />
              </tr>
            )}
          </tfoot>
        )}
      </table>
      {error && <p className="px-3 py-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// Offer the admin-managed sizes, plus whatever this row already holds, so a
// value entered before it was added to the list is never silently dropped.
function sizeOptions(sizes: LookupValue[], current: string | null): string[] {
  const values = sizes.map((s) => s.value);
  if (current && !values.includes(current)) values.push(current);
  return values;
}
