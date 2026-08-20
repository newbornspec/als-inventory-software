'use client';

import { useActionState } from 'react';
import {
  transferDevices,
  transferStock,
  type TransferResult,
} from '@/lib/actions/transfer';
import type { Location } from '@/lib/data';
import type { StockLine } from '@/lib/actions/stock';

const LABEL = 'block text-sm text-neutral-700';
const FIELD = 'field-underline w-full px-3 py-2 text-sm';

function Result({ state, unit }: { state: TransferResult; unit: string }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {state.error}
        {state.notFound && state.notFound.length > 0 && (
          <span className="mt-1 block text-xs">Not found: {state.notFound.join(', ')}</span>
        )}
      </p>
    );
  }
  if (state.moved) {
    return (
      <p role="status" className="text-sm text-emerald-800">
        Moved {state.moved} {unit}
        {state.moved === 1 ? '' : 's'}.
        {state.notFound && state.notFound.length > 0 && (
          <span className="mt-1 block text-xs text-amber-800">
            ⚠ Not found, so not moved: {state.notFound.join(', ')}
          </span>
        )}
      </p>
    );
  }
  return null;
}

// Devices are moved by TAG — what is printed on the label in your hand — and a
// textarea takes a whole handful at once. A USB scanner types a tag and presses
// Enter, which lands as one tag per line without any special handling.
export function DeviceTransfer({ locations }: { locations: Location[] }) {
  const [state, action, pending] = useActionState<TransferResult, FormData>(transferDevices, {});

  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1">
        <label htmlFor="transfer-tags" className={LABEL}>
          Device tags
        </label>
        <textarea
          id="transfer-tags"
          name="tags"
          rows={5}
          placeholder={'Scan or type one tag per line\nU-000123\nU-000124'}
          aria-describedby="transfer-tags-hint"
          className={FIELD}
        />
        <p id="transfer-tags-hint" className="text-xs text-neutral-600">
          One per line, or comma separated. A scanner that sends Enter after each
          barcode works without any setup.
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor="transfer-device-dest" className={LABEL}>
          Move to
        </label>
        <select id="transfer-device-dest" name="toLocationId" defaultValue="" className={FIELD}>
          <option value="">Choose a location…</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <Result state={state} unit="device" />

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#1a6ef5] px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
      >
        {pending ? 'Moving…' : 'Move devices'}
      </button>
    </form>
  );
}

export function StockTransfer({
  locations,
  lines,
}: {
  locations: Location[];
  lines: StockLine[];
}) {
  const [state, action, pending] = useActionState<TransferResult, FormData>(transferStock, {});

  if (lines.length === 0) {
    return <p className="text-sm text-neutral-600">No consumables to move yet.</p>;
  }

  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1">
        <label htmlFor="transfer-item" className={LABEL}>
          Item
        </label>
        <select id="transfer-item" name="stockLineId" defaultValue="" className={FIELD}>
          <option value="">Choose an item…</option>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.sku ? ` (${l.sku})` : ''} — {l.quantity} at {l.location?.name ?? 'no location'}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="transfer-qty" className={LABEL}>
            How many
          </label>
          <input
            id="transfer-qty"
            name="quantity"
            type="number"
            min={1}
            placeholder="10"
            className={FIELD}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="transfer-stock-dest" className={LABEL}>
            Move to
          </label>
          <select id="transfer-stock-dest" name="toLocationId" defaultValue="" className={FIELD}>
            <option value="">Choose a location…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="transfer-note" className={LABEL}>
          Note (optional)
        </label>
        <input id="transfer-note" name="note" placeholder="e.g. restocking the bench" className={FIELD} />
      </div>

      <Result state={state} unit="unit" />

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[#1a6ef5] px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
      >
        {pending ? 'Moving…' : 'Move stock'}
      </button>
    </form>
  );
}
