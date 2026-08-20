'use client';

import { useId, useState } from 'react';
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
  const [dataWipeMethod, setDataWipeMethod] = useState('');
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
         data_wipe_status, data_wipe_method, final_disposition, notes, created_at
       ) VALUES (uuid(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assetId,
        auditStatus || null,
        cosmeticGrade || null,
        Object.keys(tests).length ? JSON.stringify(tests) : null,
        dataWipeStatus || null,
        dataWipeMethod || null,
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
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
        Audit recorded — will sync automatically when online.
      </div>
    );
  }

  const uid = useId();

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-md border border-neutral-200 p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor={`${uid}-audit-status`} className="block text-xs text-neutral-600">Audit status</label>
          <select
            id={`${uid}-audit-status`}
            value={auditStatus}
            onChange={(e) => setAuditStatus(e.target.value)}
            className="field-underline w-full px-2 py-1.5 text-sm"
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
          <label htmlFor={`${uid}-cosmetic-grade`} className="block text-xs text-neutral-600">Cosmetic grade</label>
          <select
            id={`${uid}-cosmetic-grade`}
            value={cosmeticGrade}
            onChange={(e) => setCosmeticGrade(e.target.value)}
            className="field-underline w-full px-2 py-1.5 text-sm"
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

      <fieldset>
        <legend className="text-xs text-neutral-600">Functional tests</legend>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TEST_FIELDS.map((field) => (
            <div key={field} className="flex items-center justify-between rounded-md border border-neutral-200 px-2 py-1">
              <label htmlFor={`${uid}-test-${field}`} className="text-xs capitalize text-neutral-700">
                {field}
              </label>
              <select
                id={`${uid}-test-${field}`}
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
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor={`${uid}-wipe-status`} className="block text-xs text-neutral-600">Data wipe status</label>
          <select
            id={`${uid}-wipe-status`}
            value={dataWipeStatus}
            onChange={(e) => setDataWipeStatus(e.target.value)}
            className="field-underline w-full px-2 py-1.5 text-sm"
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
          <label htmlFor={`${uid}-disposition`} className="block text-xs text-neutral-600">Final disposition</label>
          <select
            id={`${uid}-disposition`}
            value={finalDisposition}
            onChange={(e) => setFinalDisposition(e.target.value)}
            className="field-underline w-full px-2 py-1.5 text-sm"
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
        <label htmlFor={`${uid}-wipe-method`} className="block text-xs text-neutral-600">
          Data wipe method
        </label>
        <input
          id={`${uid}-wipe-method`}
          aria-describedby={`${uid}-wipe-method-hint`}
          value={dataWipeMethod}
          onChange={(e) => setDataWipeMethod(e.target.value)}
          placeholder="e.g. NIST SP 800-88, DBAN, ATA Secure Erase, Physical destruction"
          className="field-underline w-full px-2 py-1.5 text-sm"
        />
        <p id={`${uid}-wipe-method-hint`} className="text-xs text-neutral-600">
          Appears on the data-erasure certificate.
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor={`${uid}-notes`} className="block text-xs text-neutral-600">
          Notes
        </label>
        <textarea
          id={`${uid}-notes`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="field-underline w-full px-2 py-1.5 text-sm"
        />
      </div>

      <button
        type="submit"
        disabled={saving}
        className="rounded-md bg-[#1a6ef5] hover:bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Record Audit'}
      </button>
    </form>
  );
}
