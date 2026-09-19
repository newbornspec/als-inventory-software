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

// Both clocks, as in the API copy: the station's (wipedAt, else createdAt) and
// the server's receipt time (createdAt). Blocked if EITHER says so - a record
// queued offline on the stick can reach the server days after the wipe.
export interface WipeRowLike {
  dataWipeStatus?: string | null;
  dataWipeMethod?: string | null;
  wipedAt?: Date | string | null;
  createdAt: Date | string;
}

export function isNotAnErase(method: string | null | undefined): boolean {
  if (!method) return false;
  return method.split(';').some((segment) => DISCARD.test(segment) && !REAL_ERASE.test(segment));
}

type Clock = (row: WipeRowLike) => number;
const received: Clock = (row) => new Date(row.createdAt).getTime();
const stationOrReceived: Clock = (row) => new Date(row.wipedAt ?? row.createdAt).getTime();
const CLOCKS: Clock[] = [stationOrReceived, received];

function latestOn(clock: Clock, rows: WipeRowLike[]): WipeRowLike | null {
  let latest: WipeRowLike | null = null;
  for (const r of rows) {
    if (r.dataWipeStatus !== 'wiped') continue;
    if (!latest || clock(r) > clock(latest)) latest = r;
  }
  return latest;
}

export function latestWipe(rows: WipeRowLike[]): WipeRowLike | null {
  return latestOn(stationOrReceived, rows);
}

export function failedNearWipe(wiped: WipeRowLike, rows: WipeRowLike[]): boolean {
  return CLOCKS.some((clock) => {
    const floor = clock(wiped) - MIXED_RESULT_WINDOW_MS;
    return rows.some((r) => r.dataWipeStatus === 'failed' && clock(r) >= floor);
  });
}

export type CertificateBlock = 'none' | 'discard' | 'mixed';

// --- The API's own answer (contract C4) --------------------------------------
//
// Since plan step 23 the API decides per drive (every drive's latest record a
// wipe, every internal drive accounted for) and says so at
// GET /assets/:id/certificate-eligibility. The asset page reads that instead of
// re-implementing the per-drive rule here. The copy of the interim rule above
// stays only as the FALLBACK for an API that predates the endpoint (it answers
// 404) or a request that failed: then the page behaves exactly as it did before.
export interface CertificateEligibility {
  available: boolean;
  reason: string | null;
  verdict: 'wiped' | 'failed' | 'incomplete' | 'none';
  drives: Array<{
    key: string;
    serialNumber: string | null;
    model: string | null;
    status: 'wiped' | 'failed' | 'missing';
    method: string | null;
    wipedAt: string | null;
    manual: boolean;
  }>;
}

const DISCARD_MESSAGE =
  'No erasure certificate: the latest wipe was a block discard (TRIM), which is not an erase. Wipe the drive again with the ALS audit station.';
const MIXED_MESSAGE =
  'No erasure certificate: a drive in this device failed its wipe close to (or after) the wipe on record, so it may still hold data. Wipe the failed drive again with the ALS audit station.';

export interface CertificateLinkState {
  // Offer the download link.
  offer: boolean;
  // Why not, in words - null when there is nothing to explain (no wipe at all).
  message: string | null;
  // The per-drive picture, when the API gave one.
  drives: CertificateEligibility['drives'];
}

// What the asset page shows. `eligibility` is null when the API did not answer
// (404 from an older API, or any error): "unknown", so the old local rule
// decides, as it did before the endpoint existed.
export function certificateLinkState(
  eligibility: CertificateEligibility | null,
  rows: WipeRowLike[],
): CertificateLinkState {
  if (eligibility) {
    return {
      offer: eligibility.available,
      message:
        eligibility.available || eligibility.verdict === 'none'
          ? null
          : `No erasure certificate: ${eligibility.reason ?? 'not every drive has been wiped.'}`,
      drives: eligibility.drives,
    };
  }
  const block = certificateBlock(rows);
  return {
    offer: block === null,
    message: block === 'discard' ? DISCARD_MESSAGE : block === 'mixed' ? MIXED_MESSAGE : null,
    drives: [],
  };
}

export function certificateBlock(rows: WipeRowLike[]): CertificateBlock | null {
  const latest = latestWipe(rows);
  if (!latest) return 'none';
  const byReceipt = latestOn(received, rows)!;
  if (isNotAnErase(latest.dataWipeMethod) || isNotAnErase(byReceipt.dataWipeMethod)) return 'discard';
  if (failedNearWipe(latest, rows)) return 'mixed';
  return null;
}
