import type { ErasureCertificate } from './erasure-certificate.entity';
import type { Verdict } from './certificate-signing';

// The public certificate check (plan step 30, owner decision D30): OFF unless
// PUBLIC_VERIFY_ENABLED=1. Read on every call rather than once at startup, so
// the spec can switch it; production changes it with a redeploy either way.
export function publicVerifyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PUBLIC_VERIFY_ENABLED === '1';
}

// Where a certificate's QR code points: PUBLIC_VERIFY_BASE_URL (the API's
// public address, e.g. https://api.example.com) + /verify/<id>. null when the
// base URL is not set - the certificate then prints the id without a QR.
export function verifyUrlFor(
  id: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const base = env.PUBLIC_VERIFY_BASE_URL?.trim().replace(/\/+$/, '');
  return base ? `${base}/verify/${id}` : null;
}

// EVERYTHING the public check may say about a certificate (owner decision
// D30): whether it is genuine, its number, the day it was issued, the device
// make and model, how many drives and the level reached. No serials, no
// names, no customer or lot - the payload holds all of those, and none of it
// leaves through here.
export interface PublicResult {
  valid: boolean;
  certificateNumber: string;
  issuedDate: string; // YYYY-MM-DD (UTC)
  device: { make: string | null; model: string | null };
  driveCount: number | null;
  sanitisationLevel: 'purge' | 'clear' | 'none' | null;
}

export function publicResult(
  cert: ErasureCertificate,
  verdict: Verdict,
): PublicResult {
  const s = cert.payload?.summary;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const level = s?.sanitisationLevel;
  return {
    valid: verdict.valid,
    certificateNumber: cert.number,
    issuedDate: new Date(cert.issuedAt).toISOString().slice(0, 10),
    device: { make: str(s?.make), model: str(s?.model) },
    driveCount: typeof s?.driveCount === 'number' ? s.driveCount : null,
    sanitisationLevel:
      level === 'purge' || level === 'clear' || level === 'none' ? level : null,
  };
}

const LEVEL_TEXT = {
  purge: 'Purge (NIST SP 800-88)',
  clear: 'Clear (NIST SP 800-88)',
  none: 'None',
} as const;

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

// What a phone shows after scanning the QR code: the same minimal facts as
// the JSON, as a plain page (no scripts, no external resources).
export function publicResultHtml(r: PublicResult): string {
  const rows: [string, string][] = [
    ['Certificate number', r.certificateNumber],
    ['Issued', r.issuedDate],
    [
      'Device',
      [r.device.make, r.device.model].filter(Boolean).join(' ') || '—',
    ],
    ['Drives erased', r.driveCount === null ? '—' : String(r.driveCount)],
    [
      'Sanitisation level',
      r.sanitisationLevel ? LEVEL_TEXT[r.sanitisationLevel] : 'Not assessed',
    ],
  ];
  const verdict = r.valid
    ? 'PASS - this certificate is genuine and unaltered'
    : 'FAIL - this certificate could not be verified';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Certificate check</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#111">
<h1 style="font-size:1.25rem">Certificate of Data Erasure</h1>
<p style="font-size:1.1rem;font-weight:600;color:${r.valid ? '#0a6b2d' : '#a11'}">${esc(verdict)}</p>
<table style="border-collapse:collapse">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`,
    )
    .join('')}</table>
</body></html>
`;
}
