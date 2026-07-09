'use client';

import { useState } from 'react';
import { getPowerSyncDb } from '@/lib/powersync/client';
import {
  AUDIT_STATUSES,
  CONDITION_GRADES,
  DATA_WIPE_STATUSES,
  FINAL_DISPOSITIONS,
  formatLabel,
} from '@/lib/asset-options';

const TEST_FIELDS = ['keyboard', 'ports', 'webcam', 'wifi', 'speakers'] as const;

// Writes straight to local PowerSync SQLite — the same offline-safe path
// /scan already uses for recording a scan. This is deliberate: a technician
// grading a pallet of returned laptops in a warehouse with no signal needs
// this to work exactly like scanning does. PowerSync queues the writes and
// syncs them (and denormalizes the grade/status onto the parent asset, plus
// logs the history event) once connectivity returns — see
// apps/api/src/powersync/powersync.service.ts#applyAuditSideEffects.
export function AuditForm({ assetId, onSaved }: { assetId: string; onSaved?: () => void }) {
  const [auditStatus, setAuditStatus] = useState('');
  const [cosmeticGrade, setCosmeticGrade] = useState('');
  const [tests, setTests] = useState<Record<string, string>>({});
  const [dataWipeStatus, setDataWipeStatus] = useState('');
  const [finalDisposition, setFinalDisposition] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const db = getPowerSyncDb();
    const now = new Date().toISOString();

    await db.execute(
      `INSERT INTO asset_audits (
         id, asset_id, audit_status, cosmetic_grade, functional_tests,
         data_wipe_status, final_disposition, notes, created_at
       ) VALUES (uuid(), ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assetId,
        auditStatus || null,
        cosmeticGrade || null,
        Object.keys(tests).length ? JSON.stringify(tests) : null,
        dataWipeStatus || null,
        finalDisposition || null,
        notes || null,
        now,
      ],
    );

    // Denormalize immediately so the UI reflects it before sync completes —
    // mirrors what the server does on arrival (see applyAuditSideEffects).
    const patch: string[] = [];
    const params: string[] = [];
    if (cosmeticGrade) {
      patch.push('condition_grade = ?');
      params.push(cosmeticGrade);
    }
    if (auditStatus) {
      patch.push('audit_status = ?');
      params.push(auditStatus);
    }
    if (patch.length) {
      await db.execute(`UPDATE assets SET ${patch.join(', ')} WHERE id = ?`, [...params, assetId]);
    }

    setSaving(false);
    setSaved(true);
    onSaved?.();
  }

  if (saved) {
    return (
      <div className="rounded-md border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-300">
        Audit recorded — will sync automatically when online.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-md border border-neutral-800 p-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-neutral-400">Audit status</label>
          <select
            value={auditStatus}
            onChange={(e) => setAuditStatus(e.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
          >
            <option value="">—</option>
            {AUDIT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {formatLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-neutral-400">Cosmetic grade</label>
          <select
            value={cosmeticGrade}
            onChange={(e) => setCosmeticGrade(e.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
          >
            <option value="">—</option>
            {CONDITION_GRADES.map((g) => (
              <option key={g} value={g}>
                {formatLabel(g)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="text-xs text-neutral-400">Functional tests</label>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TEST_FIELDS.map((field) => (
            <div key={field} className="flex items-center justify-between rounded-md border border-neutral-700 px-2 py-1">
              <span className="text-xs capitalize text-neutral-300">{field}</span>
              <select
                value={tests[field] ?? ''}
                onChange={(e) => setTests((prev) => ({ ...prev, [field]: e.target.value }))}
                className="bg-transparent text-xs"
              >
                <option value="">–</option>
                <option value="pass">Pass</option>
                <option value="fail">Fail</option>
                <option value="n/a">N/A</option>
              </select>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-neutral-400">Data wipe status</label>
          <select
            value={dataWipeStatus}
            onChange={(e) => setDataWipeStatus(e.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
          >
            <option value="">—</option>
            {DATA_WIPE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {formatLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-neutral-400">Final disposition</label>
          <select
            value={finalDisposition}
            onChange={(e) => setFinalDisposition(e.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
          >
            <option value="">—</option>
            {FINAL_DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {formatLabel(d)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-neutral-400">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Record Audit'}
      </button>
    </form>
  );
}
