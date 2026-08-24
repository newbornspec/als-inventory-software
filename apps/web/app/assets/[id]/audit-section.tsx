'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuditForm } from '@/app/components/audit-form';

export interface AssetAuditRecord {
  id: string;
  auditStatus: string | null;
  cosmeticGrade: string | null;
  finalDisposition: string | null;
  dataWipeStatus: string | null;
  // 'amazon' | 'goods_in' | null (Unclassified). The detail page uses it to
  // tell an Amazon-workspace device from one hand-created outside Goods In.
  auditKind?: string | null;
  notes: string | null;
  createdAt: string;
}

export function AuditSection({ assetId, audits }: { assetId: string; audits: AssetAuditRecord[] }) {
  const [showForm, setShowForm] = useState(false);
  const router = useRouter();
  const addRef = useRef<HTMLButtonElement>(null);
  const [saved, setSaved] = useState(false);
  const hasWipe = audits.some((a) => a.dataWipeStatus === 'wiped');

  // Focus the reopened "+ Record audit" button AFTER React has re-mounted it —
  // calling focus() inside onSaved ran before the re-render, when the ref was
  // still null, and keyboard focus fell back to <body>.
  useEffect(() => {
    if (saved && !showForm) addRef.current?.focus();
  }, [saved, showForm]);

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">ITAD Audits</h2>
        {!showForm && (
          <button
            ref={addRef}
            onClick={() => {
              setSaved(false);
              setShowForm(true);
            }}
            aria-expanded={showForm}
            className="text-xs text-neutral-700 underline"
          >
            + Record audit
          </button>
        )}
      </div>

      {hasWipe && (
        <a
          href={`/api/assets/${assetId}/erasure-certificate`}
          className="mt-2 inline-block rounded-md border border-emerald-200 px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50"
        >
          ↓ Data-erasure certificate (PDF)
        </a>
      )}

      {showForm && (
        <div className="mt-3">
          <AuditForm
            assetId={assetId}
            onSaved={() => {
              setShowForm(false);
              // Say it happened; the effect above restores focus to the
              // "+ Record audit" button once it has re-mounted.
              setSaved(true);
              // Re-fetches the server-rendered audit list. Only reflects the
              // new record once it's actually synced — offline, that's
              // expected: the audit itself already saved locally via
              // PowerSync, this just refreshes the online summary view.
              router.refresh();
            }}
          />
        </div>
      )}

      <p role="status" className="sr-only">
        {saved ? 'Audit saved.' : ''}
      </p>

      {/* The events themselves render once, in the Lifecycle section below —
          this section is the recording surface, not a second list. A just-saved
          audit gets its own line: offline, the server list only reflects it
          after PowerSync uploads, and "No audits recorded yet" right after
          saving one would read as a failure. */}
      <p className="mt-4 text-sm text-neutral-500">
        {saved
          ? 'Audit saved — it appears in the Lifecycle section below once synced.'
          : audits.length === 0
            ? 'No audits recorded yet.'
            : `${audits.length} audit${audits.length === 1 ? '' : 's'} recorded — see the Lifecycle section below.`}
      </p>
    </section>
  );
}
