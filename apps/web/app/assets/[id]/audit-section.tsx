'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuditForm } from '@/app/components/audit-form';
import { certificateLinkState, type CertificateEligibility } from '@/lib/certificate-eligibility';

export interface AssetAuditRecord {
  id: string;
  auditStatus: string | null;
  cosmeticGrade: string | null;
  // Graded separately from the casing: resale price follows the screen far more
  // closely, and a cracked panel on a clean chassis is a different product.
  screenGrade: string | null;
  finalDisposition: string | null;
  dataWipeStatus: string | null;
  // The recorded method - a block discard (TRIM) is never certified. Optional
  // only so older callers type-check; the API always sends it.
  dataWipeMethod?: string | null;
  // 'amazon' | 'goods_in' | null (Unclassified). The detail page uses it to
  // tell an Amazon-workspace device from one hand-created outside Goods In.
  auditKind?: string | null;
  notes: string | null;
  // When the station says the drive was wiped (NULL on legacy rows). The
  // certificate rule reads it: a record queued offline reaches the server late.
  wipedAt?: string | null;
  createdAt: string;
}

export function AuditSection({
  assetId,
  audits,
  mayRecordWipe = false,
  mayAudit = true,
  eligibility = null,
}: {
  assetId: string;
  audits: AssetAuditRecord[];
  // The API's own per-drive answer (GET /assets/:id/certificate-eligibility).
  // null = unknown (an API that predates it answers 404): the local copy of
  // the interim rule decides instead, as before.
  eligibility?: CertificateEligibility | null;
  // Holds "Record Manual Wipe" - passed through to the form. See AuditForm.
  mayRecordWipe?: boolean;
  // Holds Perform Goods In/Amazon Audit - without it the button is not shown,
  // because the API refuses the audit (and discards it if it came offline).
  mayAudit?: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const router = useRouter();
  const addRef = useRef<HTMLButtonElement>(null);
  const [saved, setSaved] = useState(false);
  // The certificate route's own answer, so the page never offers a link that
  // answers 400 and says why when it does not. No wipe at all simply shows no
  // link, as before.
  const cert = certificateLinkState(eligibility, audits);
  // Worth listing when there is more than one drive, or something to explain.
  const showDrives = cert.drives.length > 1 || (cert.drives.length > 0 && !cert.offer);

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
        {!showForm && mayAudit && (
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

      {cert.offer && (
        <a
          href={`/api/assets/${assetId}/erasure-certificate`}
          className="mt-2 inline-block rounded-md border border-emerald-200 px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50"
        >
          ↓ Data-erasure certificate (PDF)
        </a>
      )}
      {/* Say why the link is missing: a wiped device with no certificate
          otherwise reads as a bug. */}
      {cert.message && <p className="mt-2 text-xs text-amber-800">{cert.message}</p>}
      {showDrives && (
        <ul className="mt-2 space-y-0.5 text-xs text-neutral-700" aria-label="Drives in this device">
          {cert.drives.map((d) => (
            <li key={d.key}>
              <span
                className={
                  d.status === 'wiped' ? 'text-emerald-700' : d.status === 'failed' ? 'text-red-700' : 'text-amber-800'
                }
              >
                {d.status === 'wiped' ? 'Wiped' : d.status === 'failed' ? 'Failed' : 'Not wiped yet'}
              </span>
              {' — '}
              {d.model ? `${d.model} ` : ''}
              {d.serialNumber
                ? `(serial ${d.serialNumber})`
                : d.key === '(machine)'
                  ? '(drive not individually recorded)'
                  : '(serial not reported by the drive)'}
              {d.manual ? ' — recorded manually' : ''}
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <div className="mt-3">
          <AuditForm
            assetId={assetId}
            mayRecordWipe={mayRecordWipe}
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
