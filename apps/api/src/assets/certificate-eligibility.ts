import { isNotAnErase } from './wipe-method';

// May this device's wipe record be certified? One rule, used by both
// certificate routes here and - as a deliberate copy - by the web app's asset
// page (apps/web/lib/certificate-eligibility.ts), which hides the download
// link when the answer is no. The web cannot import API code, so the rule is
// kept tiny and pure, and certificate-eligibility.spec.ts runs the SAME cases
// through both copies: if either drifts, the suite fails.
//
// THE MIXED-RESULT GUARD (remediation spec D-6, owner decision D11 - an
// interim, owner-reversible policy).
//
// The station files one record per drive. A laptop with two drives where one
// erased and one failed therefore leaves a WIPED row and a FAILED row, and the
// certificate used to pick the newest WIPED row and print "data unrecoverable"
// for the whole machine - including the drive whose wipe failed. Until every
// record carries its drive's serial (later steps of the plan, which roll a
// machine's drives up properly), the only signal that two rows belong to the
// same wipe session is time. So: a FAILED row newer than the WIPED row, or
// within 24 hours before it, means "this machine may still hold data" and no
// certificate is issued until the failed drive is wiped again. A failure more
// than a day older than the wipe is taken as an earlier attempt that the later
// wipe superseded.
//
// The cost, accepted by the owner: a machine that genuinely had a failed
// attempt and a successful re-wipe of the SAME drive within the day loses its
// certificate until wiped once more. That is the safe direction to be wrong in.
export const MIXED_RESULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WipeRowLike {
  dataWipeStatus?: string | null;
  dataWipeMethod?: string | null;
  createdAt: Date | string;
}

const time = (row: WipeRowLike) => new Date(row.createdAt).getTime();

// Any FAILED row newer than `wiped`, or within the window before it.
export function failedNearWipe(
  wiped: WipeRowLike,
  rows: WipeRowLike[],
): boolean {
  const floor = time(wiped) - MIXED_RESULT_WINDOW_MS;
  return rows.some((r) => r.dataWipeStatus === 'failed' && time(r) >= floor);
}

// Why no certificate can be issued from these rows, or null when one can.
//   'none'    - no wipe recorded as wiped at all;
//   'discard' - the latest wipe was a block discard (TRIM), not an erase;
//   'mixed'   - a drive failed its wipe close to (or after) the latest wipe.
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

export const MIXED_REFUSAL =
  'A drive in this device failed its wipe close to (or after) the wipe on record, so the device may still ' +
  'hold data. No erasure certificate can be issued for it. Wipe the failed drive again with the ALS audit ' +
  'station; a certificate is available once no failed wipe sits within 24 hours of a successful one.';

// The lot certificate's line for devices it left off for that reason - the
// same job as discardedNotice in wipe-method.ts.
export function mixedNotice(n: number): string {
  return `${n} further device${n === 1 ? '' : 's'} in this lot ${n === 1 ? 'is' : 'are'} not listed: a drive in ${
    n === 1 ? 'it' : 'each'
  } failed its wipe close to (or after) the wipe on record, so ${n === 1 ? 'it' : 'they'} may still hold data. ${
    n === 1 ? 'It is' : 'They are'
  } not certified by this document.`;
}
