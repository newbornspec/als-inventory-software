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

// Sentinel for the Size dropdown. Not a size, so it can never collide with a
// real one, and never saved — picking it only reveals the manual input.
const CUSTOM_SIZE = '__custom__';
// Stands in for the new-row form in the per-row custom-size maps.
const ADD_ROW = '__add__';

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

  // Which rows have switched their Size dropdown to manual entry. Keyed by line
  // id, with ADD_ROW standing in for the new-row form at the bottom. Panel
  // sizes are not all whole inches — 23.8" and 21.5" are ordinary — and the
  // managed list cannot practically hold every one.
  const [customSize, setCustomSize] = useState<Record<string, boolean>>({});
  const [sizeError, setSizeError] = useState<Record<string, string>>({});

  function chooseSize(key: string, value: string, commit: (size: string) => void) {
    if (value === CUSTOM_SIZE) {
      setCustomSize((c) => ({ ...c, [key]: true }));
      return; // nothing saved yet — the operator has not typed a size
    }
    setCustomSize((c) => ({ ...c, [key]: false }));
    setSizeError((e) => ({ ...e, [key]: '' }));
    commit(value);
  }

  // Accepts 23.8 and stores 23.8" so a typed size is indistinguishable from a
  // listed one everywhere downstream — the grid, the exports and the invoice.
  function commitCustomSize(key: string, raw: string, commit: (size: string) => void) {
    const n = Number(raw);
    if (raw.trim() === '' || Number.isNaN(n)) {
      setSizeError((e) => ({ ...e, [key]: 'Enter a number, e.g. 23.8' }));
      return;
    }
    if (n <= 0) {
      setSizeError((e) => ({ ...e, [key]: 'Size must be greater than 0.' }));
      return;
    }
    setSizeError((e) => ({ ...e, [key]: '' }));
    setCustomSize((c) => ({ ...c, [key]: false }));
    commit(`${n}"`);
  }

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
    <div role="region" aria-label="Pallet contents" tabIndex={0} className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
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
                      aria-label={`Manufacturer for ${l.variant}`}
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
                      aria-label={`Model for ${l.variant}`}
                      onBlur={(e) => save(l, { model: e.target.value })}
                      className={field}
                    />
                  ) : (
                    <span className="text-neutral-700">{l.model ?? '—'}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {canManage ? (
                    <>
                      <select
                        aria-label={`Size for ${l.variant}`}
                        value={customSize[l.id] ? CUSTOM_SIZE : (l.size ?? '')}
                        onChange={(e) =>
                          chooseSize(l.id, e.target.value, (size) => save(l, { size }))
                        }
                        className={field}
                      >
                        <option value="">—</option>
                        {/* First, so it is obvious a size can be typed. */}
                        <option value={CUSTOM_SIZE} className="bg-white">
                          Custom / Enter manually
                        </option>
                        {sizeOptions(sizes, l.size).map((s) => (
                          <option key={s} value={s} className="bg-white">
                            {s}
                          </option>
                        ))}
                      </select>
                      {customSize[l.id] && (
                        <div className="mt-1">
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min={0}
                              step="0.1"
                              autoFocus
                              aria-label="Screen size in inches"
                              placeholder="23.8"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur();
                              }}
                              onBlur={(e) =>
                                commitCustomSize(l.id, e.target.value, (size) =>
                                  save(l, { size }),
                                )
                              }
                              className="w-20 rounded border border-neutral-200 bg-white px-2 py-1.5"
                            />
                            <span className="text-xs text-neutral-500">inches</span>
                          </div>
                          {sizeError[l.id] && (
                            <p className="mt-0.5 text-xs text-red-600">{sizeError[l.id]}</p>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-neutral-700">{l.size ?? '—'}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {canManage ? (
                    <select
                      defaultValue={l.variantType ?? ''}
                      aria-label={`Variant for ${l.variant}`}
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
                      aria-label={`Stand included for ${l.variant}`}
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
                      aria-label={`Quantity for ${l.variant}`}
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
                      aria-label={`Grade for ${l.variant}`}
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
                      aria-label={`Unit cost for ${l.variant}`}
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
                  aria-label="New row: manufacturer"
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
                  aria-label="New row: model"
                  value={add.model ?? ''}
                  onChange={(e) => setAdd((a) => ({ ...a, model: e.target.value }))}
                  placeholder="e.g. P2419H"
                  className={field}
                />
              </td>
              <td className="px-3 py-2">
                <select
                  aria-label="New row: size"
                  value={customSize[ADD_ROW] ? CUSTOM_SIZE : (add.size ?? '')}
                  onChange={(e) =>
                    chooseSize(ADD_ROW, e.target.value, (size) =>
                      setAdd((a) => ({ ...a, size })),
                    )
                  }
                  className={field}
                >
                  <option value="">—</option>
                  <option value={CUSTOM_SIZE} className="bg-white">
                    Custom / Enter manually
                  </option>
                  {sizeOptions(sizes, add.size ?? null).map((s) => (
                    <option key={s} value={s} className="bg-white">
                      {s}
                    </option>
                  ))}
                </select>
                {customSize[ADD_ROW] && (
                  <div className="mt-1">
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        step="0.1"
                        autoFocus
                        aria-label="Screen size in inches"
                        placeholder="23.8"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                        }}
                        onBlur={(e) =>
                          commitCustomSize(ADD_ROW, e.target.value, (size) =>
                            setAdd((a) => ({ ...a, size })),
                          )
                        }
                        className="w-20 rounded border border-neutral-200 bg-white px-2 py-1.5"
                      />
                      <span className="text-xs text-neutral-500">inches</span>
                    </div>
                    {sizeError[ADD_ROW] && (
                      <p className="mt-0.5 text-xs text-red-600">{sizeError[ADD_ROW]}</p>
                    )}
                  </div>
                )}
              </td>
              <td className="px-3 py-2">
                <select
                  aria-label="New row: variant"
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
                  aria-label="New row: stand included"
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
                  aria-label="New row: quantity"
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
                  aria-label="New row: grade"
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
                  aria-label="New row: unit cost"
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
                  className="rounded bg-[#1a6ef5] px-2 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
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
