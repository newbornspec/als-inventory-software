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
import { PALLET_LINE_GRADES, PALLET_VARIANT_TYPES, formatLabel } from '@/lib/asset-options';

// One row per product/variant combination, matching the sheet the warehouse
// keeps by hand: Manufacturer · Model · Size · Variant · Stand · Qty · Grade ·
// Unit cost · Line total. The pallet number is not a column here — it is the
// page heading, and it is written onto every row of the Excel export.
//
// Manufacturer, model and size come from the admin-managed lookup list, so the
// business extends them at /lookups without a code change. Model is scoped to
// the manufacturer via parentId, so choosing Dell offers Dell's models.

type Draft = { quantity?: number; unitCost?: number | null };

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

  // Local echo of quantity/unit cost so Line total updates as you type, before
  // the field blurs and the server round-trips.
  const [draft, setDraft] = useState<Record<string, Draft>>({});

  // The new-row form.
  const [add, setAdd] = useState<PalletLinePatch>({});

  const active = (c: string) => lookups.filter((l) => l.category === c && l.active);
  const manufacturers = useMemo(() => active('manufacturer'), [lookups]);
  const sizes = useMemo(() => active('size'), [lookups]);
  const models = useMemo(() => lookups.filter((l) => l.category === 'model' && l.active), [lookups]);

  // Models for one manufacturer NAME (rows store the name, lookups link by id).
  function modelsFor(manufacturer: string | null | undefined): string[] {
    const man = manufacturers.find(
      (m) => m.value.toLowerCase() === (manufacturer ?? '').trim().toLowerCase(),
    );
    // No manufacturer chosen yet -> offer everything rather than nothing, so the
    // field is never mysteriously empty.
    const pool = man ? models.filter((m) => m.parentId === man.id) : models;
    return pool.map((m) => m.value);
  }

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

  // Quantity x unit cost, preferring anything typed but not yet saved.
  function lineTotal(l: PalletLine): number | null {
    const d = draft[l.id] ?? {};
    const qty = d.quantity ?? l.quantity;
    const cost = d.unitCost !== undefined ? d.unitCost : l.unitCost;
    return cost != null ? cost * qty : null;
  }

  const grandTotal = lines.reduce((sum, l) => sum + (lineTotal(l) ?? 0), 0);
  const totalUnits = lines.reduce(
    (sum, l) => sum + (draft[l.id]?.quantity ?? l.quantity),
    0,
  );
  const addTotal =
    add.unitCost != null && add.quantity != null ? add.unitCost * add.quantity : null;

  const input = 'w-full rounded border border-neutral-200 bg-white px-2 py-1.5';
  const cols = canManage ? 10 : 9;

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
      <datalist id="pl-manufacturers">
        {manufacturers.map((m) => (
          <option key={m.id} value={m.value} />
        ))}
      </datalist>
      {/* One list per manufacturer, so a row's model field can point at the
          right one. Plus an "all models" list for rows with no manufacturer. */}
      <datalist id="pl-models-all">
        {models.map((m) => (
          <option key={m.id} value={m.value} />
        ))}
      </datalist>

      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-50 text-neutral-500">
          <tr>
            <th className="min-w-[9rem] px-3 py-2">Manufacturer</th>
            <th className="min-w-[10rem] px-3 py-2">Model</th>
            <th className="w-28 px-3 py-2">Size</th>
            <th className="w-32 px-3 py-2">Variant</th>
            <th className="w-24 px-3 py-2">Stand</th>
            <th className="w-24 px-3 py-2">Quantity</th>
            <th className="w-32 px-3 py-2">Grade</th>
            <th className="w-28 px-3 py-2">Unit cost (£)</th>
            <th className="w-28 px-3 py-2">Line total</th>
            {canManage && <th className="w-24 px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            // A row created before Layout 1 offered only A-D may hold for_parts
            // or scrap. Append it, or the select renders blank and the next
            // change would save that blank over real data.
            const grades =
              l.grade && !PALLET_LINE_GRADES.includes(l.grade)
                ? [...PALLET_LINE_GRADES, l.grade]
                : PALLET_LINE_GRADES;
            const total = lineTotal(l);
            return (
              <tr key={l.id} className="border-t border-neutral-200">
                <td className="px-3 py-2">
                  {canManage ? (
                    <input
                      list="pl-manufacturers"
                      defaultValue={l.manufacturer ?? ''}
                      placeholder="—"
                      onBlur={(e) => save(l, { manufacturer: e.target.value })}
                      className={input}
                    />
                  ) : (
                    <span className="text-neutral-900">{l.manufacturer ?? '—'}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {canManage ? (
                    <input
                      list={l.manufacturer ? `pl-models-${slug(l.manufacturer)}` : 'pl-models-all'}
                      defaultValue={l.model ?? ''}
                      placeholder="—"
                      onBlur={(e) => save(l, { model: e.target.value })}
                      className={input}
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
                      className={input}
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
                      className={input}
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
                      className={input}
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
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          [l.id]: { ...d[l.id], quantity: parseInt(e.target.value || '0', 10) || 0 },
                        }))
                      }
                      onBlur={(e) => save(l, { quantity: parseInt(e.target.value || '0', 10) })}
                      className="w-20 rounded border border-neutral-200 bg-white px-2 py-1.5"
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
                      className={input}
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
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          [l.id]: {
                            ...d[l.id],
                            unitCost: e.target.value ? parseFloat(e.target.value) : null,
                          },
                        }))
                      }
                      onBlur={(e) =>
                        save(l, { unitCost: e.target.value ? parseFloat(e.target.value) : null })
                      }
                      className="w-24 rounded border border-neutral-200 bg-white px-2 py-1.5"
                    />
                  ) : l.unitCost != null ? (
                    money(l.unitCost)
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2 font-medium text-neutral-900">
                  {total != null ? money(total) : '—'}
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

        {/* Per-manufacturer model lists, rendered once for every manufacturer
            that has models, so each row's input can point at its own. */}
        {manufacturers.map((m) => (
          <datalist key={m.id} id={`pl-models-${slug(m.value)}`}>
            {models
              .filter((x) => x.parentId === m.id)
              .map((x) => (
                <option key={x.id} value={x.value} />
              ))}
          </datalist>
        ))}

        {canManage && (
          <tfoot>
            <tr className="border-t border-neutral-200 bg-neutral-50">
              <td className="px-3 py-2">
                <input
                  list="pl-manufacturers"
                  value={add.manufacturer ?? ''}
                  onChange={(e) => setAdd((a) => ({ ...a, manufacturer: e.target.value }))}
                  placeholder="e.g. Dell"
                  className={input}
                />
              </td>
              <td className="px-3 py-2">
                <input
                  list={
                    add.manufacturer ? `pl-models-${slug(add.manufacturer)}` : 'pl-models-all'
                  }
                  value={add.model ?? ''}
                  onChange={(e) => setAdd((a) => ({ ...a, model: e.target.value }))}
                  placeholder="e.g. P2419H"
                  className={input}
                />
              </td>
              <td className="px-3 py-2">
                <select
                  value={add.size ?? ''}
                  onChange={(e) => setAdd((a) => ({ ...a, size: e.target.value }))}
                  className={input}
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
                  className={input}
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
                  className={input}
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
                  className="w-20 rounded border border-neutral-200 bg-white px-2 py-1.5"
                />
              </td>
              <td className="px-3 py-2">
                <select
                  value={add.grade ?? ''}
                  onChange={(e) => setAdd((a) => ({ ...a, grade: e.target.value }))}
                  className={input}
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
                  className="w-24 rounded border border-neutral-200 bg-white px-2 py-1.5"
                />
              </td>
              <td className="px-3 py-2 text-neutral-500">
                {addTotal != null ? money(addTotal) : '—'}
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
                <td className="px-3 py-2">{grandTotal > 0 ? money(grandTotal) : '—'}</td>
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

// datalist ids have to be valid HTML ids, and manufacturer names contain spaces
// and dots ("Intel NUC", "Tier 1").
function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// Offer the admin-managed sizes, plus whatever this row already holds, so a
// value entered before it was added to the list is never silently dropped.
function sizeOptions(sizes: LookupValue[], current: string | null): string[] {
  const values = sizes.map((s) => s.value);
  if (current && !values.includes(current)) values.push(current);
  return values;
}
