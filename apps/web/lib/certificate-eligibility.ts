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

// What asking the API for C4 came to:
//   - its answer;
//   - null: "unknown" - an API that predates the endpoint (404), so the old
//     local rule decides, as it did before the endpoint existed;
//   - 'unavailable': an API that has the endpoint failed to answer (5xx, a
//     network error, or no answer within ELIGIBILITY_TIMEOUT_MS). NOT the
//     local fallback: the local rule knows nothing about per-drive
//     completeness, so it offered a link for an incomplete machine that the
//     certificate route then refused with a 400 (cross-check, wave 2);
//   - 'denied': 401/403 - the download has the same permissions, so there is
//     no link to offer.
export type EligibilityAnswer = CertificateEligibility | null | 'unavailable' | 'denied';

// C4 runs in the asset page's Promise.all, so a slow answer held up the whole
// page for as long as the platform's own fetch timeout. The endpoint is one
// indexed read of the asset's wipe rows; 3 s is far more than it needs.
export const ELIGIBILITY_TIMEOUT_MS = 3000;

// Ask for C4 with a time limit. `get` does the request with the signal it is
// given (apiFetch in the page); the time limit holds even if it ignores it.
// An error's `status` (ApiError's) tells a 404 from a failure.
export async function fetchEligibility(
  get: (signal: AbortSignal) => Promise<CertificateEligibility>,
  timeoutMs: number = ELIGIBILITY_TIMEOUT_MS,
): Promise<EligibilityAnswer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'unavailable'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('unavailable');
    }, timeoutMs);
  });
  try {
    return await Promise.race([get(controller.signal), timedOut]);
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    if (status === 404) return null;
    if (status === 401 || status === 403) return 'denied';
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

const UNAVAILABLE_MESSAGE =
  'Whether an erasure certificate can be issued for this device could not be checked just now. Reload the page to try again.';

// What the asset page shows, from the C4 answer (see EligibilityAnswer).
export function certificateLinkState(
  eligibility: EligibilityAnswer,
  rows: WipeRowLike[],
): CertificateLinkState {
  if (eligibility === 'denied') return { offer: false, message: null, drives: [] };
  if (eligibility === 'unavailable')
    return {
      offer: false,
      // Never wiped: nothing to explain, as before.
      message: latestWipe(rows) ? UNAVAILABLE_MESSAGE : null,
      drives: [],
    };
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
