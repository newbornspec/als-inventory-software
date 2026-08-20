'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createRepair,
  updateRepair,
  deleteRepair,
  type RepairLog,
  type RepairStatus,
} from '@/lib/actions/repairs';
import { money } from '@/lib/money';
import { formatLabel } from '@/lib/asset-options';

const REPAIR_STATUSES: RepairStatus[] = ['pending', 'in_progress', 'completed', 'cannot_repair'];

export function RepairsSection({
  assetId,
  repairs,
  canManage,
}: {
  assetId: string;
  repairs: RepairLog[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [description, setDescription] = useState('');
  const [parts, setParts] = useState('');
  const [cost, setCost] = useState('');
  const [status, setStatus] = useState<RepairStatus>('pending');
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
    if (!description.trim()) {
      setError('Describe the repair.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await createRepair(assetId, description, parts, cost ? parseFloat(cost) : null, status);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setDescription('');
    setParts('');
    setCost('');
    setStatus('pending');
    router.refresh();
  }

  const save = (r: RepairLog, next: Partial<Pick<RepairLog, 'description' | 'partsUsed' | 'cost' | 'status'>>) =>
    run(() =>
      updateRepair(
        assetId,
        r.id,
        next.description ?? r.description,
        next.partsUsed ?? r.partsUsed ?? '',
        next.cost !== undefined ? next.cost : r.cost,
        next.status ?? r.status,
      ),
    );

  return (
    <section>
      <h2 className="text-sm font-medium text-neutral-500">Repairs &amp; refurbishment</h2>
      <div role="region" aria-label="Repair log" tabIndex={0} className="mt-3 overflow-x-auto rounded-lg border border-[var(--grid-line)]">
        <table data-dense-grid className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Repair jobs logged against this device</caption>
          <thead className="bg-neutral-50 text-neutral-500">
            <tr>
              <th scope="col" className="border-l border-[var(--grid-line)] px-3 py-2 first:border-l-0">Work / fault</th>
              <th scope="col" className="border-l border-[var(--grid-line)] px-3 py-2 first:border-l-0">Parts</th>
              <th scope="col" className="w-24 border-l border-[var(--grid-line)] px-3 py-2 first:border-l-0">Cost (£)</th>
              <th scope="col" className="w-36 border-l border-[var(--grid-line)] px-3 py-2 first:border-l-0">Status</th>
              <th scope="col" className="border-l border-[var(--grid-line)] px-3 py-2 first:border-l-0">By / when</th>
              {canManage && <th scope="col" className="w-14 border-l border-[var(--grid-line)] px-3 py-2 first:border-l-0" />}
            </tr>
          </thead>
          <tbody>
            {repairs.map((r) => (
              <tr key={r.id} className="border-t border-[var(--grid-line)] align-top">
                <td className="border-l border-[var(--grid-line)] p-0 transition-colors first:border-l-0 hover:bg-neutral-100 focus-within:bg-blue-50">
                  <input
                    aria-label="Work or fault"
                    defaultValue={r.description}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== r.description && save(r, { description: e.target.value })}
                    className="block w-full bg-transparent px-3 py-2"
                  />
                </td>
                <td className="border-l border-[var(--grid-line)] p-0 transition-colors first:border-l-0 hover:bg-neutral-100 focus-within:bg-blue-50">
                  <input
                    aria-label="Parts used"
                    defaultValue={r.partsUsed ?? ''}
                    placeholder="—"
                    onBlur={(e) => e.target.value !== (r.partsUsed ?? '') && save(r, { partsUsed: e.target.value })}
                    className="block w-full bg-transparent px-3 py-2"
                  />
                </td>
                <td className="border-l border-[var(--grid-line)] p-0 transition-colors first:border-l-0 hover:bg-neutral-100 focus-within:bg-blue-50">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    aria-label="Repair cost in pounds"
                    defaultValue={r.cost ?? ''}
                    placeholder="—"
                    onBlur={(e) => {
                      const v = e.target.value ? parseFloat(e.target.value) : null;
                      if (v !== r.cost) save(r, { cost: v });
                    }}
                    className="block w-full bg-transparent px-3 py-2 text-right tabular-nums"
                  />
                </td>
                <td className="border-l border-[var(--grid-line)] p-0 transition-colors first:border-l-0 hover:bg-neutral-100 focus-within:bg-blue-50">
                  <select
                    aria-label="Repair status"
                    defaultValue={r.status}
                    onChange={(e) => save(r, { status: e.target.value as RepairStatus })}
                    className="block w-full bg-transparent px-3 py-2"
                  >
                    {REPAIR_STATUSES.map((s) => (
                      <option key={s} value={s} className="bg-white">
                        {formatLabel(s)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="border-l border-[var(--grid-line)] px-3 py-2 text-xs text-neutral-600">
                  {r.performedBy?.name ?? '—'}
                  <br />
                  {new Date(r.createdAt).toLocaleDateString()}
                </td>
                {canManage && (
                  <td className="border-l border-[var(--grid-line)] px-3 py-2">
                    <button
                      onClick={() => run(() => deleteRepair(assetId, r.id))}
                      aria-label={`Remove repair: ${r.description}`}
                      className="text-xs text-red-700 hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {repairs.length === 0 && (
              <tr>
                <td colSpan={canManage ? 6 : 5} className="px-3 py-6 text-center text-neutral-500">
                  No repairs logged.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--grid-line)] bg-neutral-50">
              <td className="border-l border-[var(--grid-line)] p-0 transition-colors first:border-l-0 hover:bg-neutral-100 focus-within:bg-blue-50">
                <input
                  aria-label="New repair: work or fault"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Replaced faulty charging port"
                  className="block w-full bg-transparent px-3 py-2"
                />
              </td>
              <td className="border-l border-[var(--grid-line)] p-0 transition-colors first:border-l-0 hover:bg-neutral-100 focus-within:bg-blue-50">
                <input
                  aria-label="New repair: parts used"
                  value={parts}
                  onChange={(e) => setParts(e.target.value)}
                  placeholder="parts (optional)"
                  className="block w-full bg-transparent px-3 py-2"
                />
              </td>
              <td className="border-l border-[var(--grid-line)] p-0 transition-colors first:border-l-0 hover:bg-neutral-100 focus-within:bg-blue-50">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  aria-label="New repair: cost in pounds"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="optional"
                  className="block w-full bg-transparent px-3 py-2 text-right tabular-nums"
                />
              </td>
              <td className="border-l border-[var(--grid-line)] p-0 transition-colors first:border-l-0 hover:bg-neutral-100 focus-within:bg-blue-50">
                <select
                  aria-label="New repair: status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as RepairStatus)}
                  className="block w-full bg-transparent px-3 py-2"
                >
                  {REPAIR_STATUSES.map((s) => (
                    <option key={s} value={s} className="bg-white">
                      {formatLabel(s)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="border-l border-[var(--grid-line)] px-3 py-2" />
              <td className="border-l border-[var(--grid-line)] px-3 py-2">
                <button
                  onClick={add}
                  disabled={busy}
                  className="rounded bg-[#1a6ef5] hover:bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                >
                  {busy ? '…' : 'Add'}
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
        {error && <p role="alert" className="px-3 py-2 text-xs text-red-700">{error}</p>}
      </div>
    </section>
  );
}
