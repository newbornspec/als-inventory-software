// May this device's wipe record be certified? A deliberate COPY of the API's
// rule in apps/api/src/assets/certificate-eligibility.ts (and the discard test
// from apps/api/src/assets/wipe-method.ts): the web app cannot import API code,
// and the asset page must not offer a certificate link that the API will then
// refuse. apps/api/src/assets/certificate-eligibility.spec.ts runs the same
// cases through this file and the API's, so the two cannot drift silently.
// Change both together. Keep this file dependency-free.
//
// Why each rule exists is written up in the API copy. In short:
//   - a block discard (TRIM) is not an erase, so it is never certified;
//   - a FAILED wipe newer than the latest WIPED one, or within 24 hours before
//     it, means another drive of the machine may still hold data (an interim,
//     owner-reversible policy until per-drive records roll up).

const DISCARD = /block discard|blkdiscard|\btrim\b/i;
const REAL_ERASE = /overwrite|erase|sanitiz|sanitis|shred|zero pass|destr/i;

export const MIXED_RESULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WipeRowLike {
  dataWipeStatus?: string | null;
  dataWipeMethod?: string | null;
  createdAt: Date | string;
}

export function isNotAnErase(method: string | null | undefined): boolean {
  if (!method) return false;
  return method.split(';').some((segment) => DISCARD.test(segment) && !REAL_ERASE.test(segment));
}

const time = (row: WipeRowLike) => new Date(row.createdAt).getTime();

export function failedNearWipe(wiped: WipeRowLike, rows: WipeRowLike[]): boolean {
  const floor = time(wiped) - MIXED_RESULT_WINDOW_MS;
  return rows.some((r) => r.dataWipeStatus === 'failed' && time(r) >= floor);
}

export type CertificateBlock = 'none' | 'discard' | 'mixed';

export function certificateBlock(rows: WipeRowLike[]): CertificateBlock | null {
  let latest: WipeRowLike | null = null;
  for (const r of rows) {
    if (r.dataWipeStatus !== 'wiped') continue;
    if (!latest || time(r) > time(latest)) latest = r;
  }
  if (!latest) return 'none';
  if (isNotAnErase(latest.dataWipeMethod)) return 'discard';
  if (failedNearWipe(latest, rows)) return 'mixed';
  return null;
}
