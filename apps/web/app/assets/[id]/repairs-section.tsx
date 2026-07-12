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
      <h2 className="text-sm font-medium text-neutral-400">Repairs &amp; refurbishment</h2>
      <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-3 py-2">Work / fault</th>
              <th className="px-3 py-2">Parts</th>
              <th className="w-24 px-3 py-2">Cost (£)</th>
              <th className="w-36 px-3 py-2">Status</th>
              <th className="px-3 py-2">By / when</th>
              {canManage && <th className="w-14 px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {repairs.map((r) => (
              <tr key={r.id} className="border-t border-neutral-800 align-top">
                <td className="px-3 py-2">
                  <input
                    defaultValue={r.description}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== r.description && save(r, { description: e.target.value })}
                    className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    defaultValue={r.partsUsed ?? ''}
                    placeholder="—"
                    onBlur={(e) => e.target.value !== (r.partsUsed ?? '') && save(r, { partsUsed: e.target.value })}
                    className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    defaultValue={r.cost ?? ''}
                    placeholder="—"
                    onBlur={(e) => {
                      const v = e.target.value ? parseFloat(e.target.value) : null;
                      if (v !== r.cost) save(r, { cost: v });
                    }}
                    className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                  />
                </td>
                <td className="px-3 py-2">
                  <select
                    defaultValue={r.status}
                    onChange={(e) => save(r, { status: e.target.value as RepairStatus })}
                    className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                  >
                    {REPAIR_STATUSES.map((s) => (
                      <option key={s} value={s} className="bg-neutral-900">
                        {formatLabel(s)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2 text-xs text-neutral-500">
                  {r.performedBy?.name ?? '—'}
                  <br />
                  {new Date(r.createdAt).toLocaleDateString()}
                </td>
                {canManage && (
                  <td className="px-3 py-2">
                    <button
                      onClick={() => run(() => deleteRepair(assetId, r.id))}
                      className="text-xs text-red-400 hover:underline"
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
            <tr className="border-t border-neutral-800 bg-neutral-900/40">
              <td className="px-3 py-2">
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Replaced faulty charging port"
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
              <td className="px-3 py-2">
                <input
                  value={parts}
                  onChange={(e) => setParts(e.target.value)}
                  placeholder="parts (optional)"
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
              <td className="px-3 py-2">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="optional"
                  className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                />
              </td>
              <td className="px-3 py-2">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as RepairStatus)}
                  className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                >
                  {REPAIR_STATUSES.map((s) => (
                    <option key={s} value={s} className="bg-neutral-900">
                      {formatLabel(s)}
                    </option>
                  ))}
                </select>
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
        </table>
        {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}
      </div>
    </section>
  );
}
