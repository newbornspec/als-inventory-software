'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuditForm } from '@/app/components/audit-form';
import { formatLabel } from '@/lib/asset-options';

export interface AssetAuditRecord {
  id: string;
  auditStatus: string | null;
  cosmeticGrade: string | null;
  finalDisposition: string | null;
  dataWipeStatus: string | null;
  notes: string | null;
  createdAt: string;
}

export function AuditSection({ assetId, audits }: { assetId: string; audits: AssetAuditRecord[] }) {
  const [showForm, setShowForm] = useState(false);
  const router = useRouter();
  const hasWipe = audits.some((a) => a.dataWipeStatus === 'wiped');

  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-400">ITAD Audits</h2>
        {!showForm && (
          <button onClick={() => setShowForm(true)} className="text-xs text-neutral-400 underline">
            + Record audit
          </button>
        )}
      </div>

      {hasWipe && (
        <a
          href={`/api/assets/${assetId}/erasure-certificate`}
          className="mt-2 inline-block rounded-md border border-emerald-800 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-950/40"
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
              // Re-fetches the server-rendered audit list. Only reflects the
              // new record once it's actually synced — offline, that's
              // expected: the audit itself already saved locally via
              // PowerSync, this just refreshes the online summary view.
              router.refresh();
            }}
          />
        </div>
      )}

      <ul className="mt-4 space-y-3">
        {audits.map((a) => (
          <li key={a.id} className="border-l-2 border-neutral-800 pl-3 text-sm">
            <div className="text-neutral-200">
              {a.auditStatus ? formatLabel(a.auditStatus) : 'Audit recorded'}
              {a.cosmeticGrade && ` · ${formatLabel(a.cosmeticGrade)}`}
            </div>
            {a.finalDisposition && (
              <div className="text-neutral-500">Disposition: {formatLabel(a.finalDisposition)}</div>
            )}
            {a.dataWipeStatus && (
              <div className="text-neutral-500">Data wipe: {formatLabel(a.dataWipeStatus)}</div>
            )}
            {a.notes && <div className="text-neutral-500">{a.notes}</div>}
            <div className="text-xs text-neutral-600">{new Date(a.createdAt).toLocaleString()}</div>
          </li>
        ))}
        {audits.length === 0 && !showForm && (
          <li className="text-sm text-neutral-500">No audits recorded yet.</li>
        )}
      </ul>
    </section>
  );
}
