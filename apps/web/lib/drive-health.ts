// How a drive's health (contract C5, profile.storage[i].health) is WORDED in
// the web app. A deliberate COPY of apps/api/src/devices/drive-health.ts - the
// web app cannot import API code, and the asset page and Audit workspace must
// word a drive exactly as the xlsx reports do. apps/api/src/devices/
// drive-health.spec.ts runs every case through BOTH files, so the two cannot
// drift silently. Change both together, and keep this file dependency-free
// (no imports) so it stays byte-identical to the API copy below this header.
//
// Rules this file enforces (owner's request, 2026-09-19):
//   - The percentage is the one the station engine measured from the drive's
//     own SMART / eMMC data by the documented formula. Nothing here invents,
//     estimates or recomputes one.
//   - The status is DERIVED from the percentage by the owner's bands (Good
//     90-100, Caution 50-89, Bad 0-49), never read from a separate field, so a
//     stored status can never disagree with the number printed beside it.
//   - "Unknown" is never an answer. A drive the station could not read says why
//     and what to do; a profile captured before drive health existed says "Not
//     scanned yet - rescan on the station". The legacy healthPct those old
//     profiles carry was computed differently (one vendor wear attribute) and is
//     deliberately NOT presented as the new percentage.

export type HealthStatus = 'good' | 'caution' | 'bad';
export type HealthTone = 'good' | 'warn' | 'bad' | 'neutral';

export const GOOD_FROM = 90;
export const CAUTION_FROM = 50;

export const STATUS_LABEL: Record<HealthStatus, string> = {
  good: 'Good',
  caution: 'Caution',
  bad: 'Bad',
};

export const NOT_SCANNED = 'Not scanned yet — rescan on the station';
// Used when the station recorded "not measurable" but not why, or sent a value
// this file cannot trust. Still a reason and an action, never "Unknown".
const NO_REASON = 'the station did not record why';
const RESCAN = 'press Rescan on the station';

export interface DriveHealthView {
  kind: 'measured' | 'not-measurable' | 'not-scanned';
  // "94% · Good" | "Not measurable — <reason>" | "Not scanned yet — rescan on the station"
  headline: string;
  // One report cell for this drive alone:
  // "94% Good" | "Not measurable — <reason> — <action>" | NOT_SCANNED
  cell: string;
  percent: number | null;
  status: HealthStatus | null;
  tone: HealthTone;
  // What the percentage came from ("life remaining 94% reported by the drive").
  basis: string | null;
  // Not measurable only: what the operator should do.
  action: string | null;
  // Every deduction or cap the station applied, in its own words.
  reasons: string[];
  // Key numbers where there is room: "36 °C", "5,678 h powered on", ...
  facts: string[];
  // An old profile (no health) whose legacy SMART verdict was FAILED. That
  // verdict came from the drive itself, so it is still shown - just never
  // turned into a percentage.
  legacySmartFailed: boolean;
}

export function statusForPercent(percent: number): HealthStatus {
  if (percent >= GOOD_FROM) return 'good';
  if (percent >= CAUTION_FROM) return 'caution';
  return 'bad';
}

const TONE: Record<HealthStatus, HealthTone> = {
  good: 'good',
  caution: 'warn',
  bad: 'bad',
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// A count/measurement the station reported, or null. Negative or non-finite
// values are not measurements.
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// Station-supplied text. An "unknown" placeholder is treated as no text at all,
// so it can never reach the screen as a health result.
function words(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || /^unknown$/i.test(t)) return null;
  return t;
}

function thousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function plural(n: number, one: string, many: string): string {
  return `${thousands(n)} ${n === 1 ? one : many}`;
}

function facts(h: Obj): string[] {
  const out: string[] = [];
  const temp = num(h.temperatureC);
  if (temp != null) out.push(`${Math.round(temp)} °C`);
  const hours = num(h.powerOnHours);
  if (hours != null) out.push(`${thousands(hours)} h powered on`);
  const used = num(h.lifeUsedPct);
  if (used != null) out.push(`${Math.round(used)}% life used`);

  // NVMe counts media errors; ATA drives count bad sectors. Whichever the
  // drive reported - both only if it somehow reported both.
  const media = num(h.mediaErrors);
  if (media != null)
    out.push(
      media === 0
        ? 'no media errors'
        : plural(media, 'media error', 'media errors'),
    );
  const sectors: [string, number | null][] = [
    ['reallocated', num(h.reallocatedSectors)],
    ['pending', num(h.pendingSectors)],
    ['uncorrectable', num(h.uncorrectableSectors)],
  ];
  const reported = sectors.filter(([, n]) => n != null) as [string, number][];
  if (reported.length) {
    const bad = reported.filter(([, n]) => n > 0);
    out.push(
      bad.length
        ? `${bad.map(([k, n]) => `${thousands(n)} ${k}`).join(', ')} sector${
            bad.length === 1 && bad[0][1] === 1 ? '' : 's'
          }`
        : 'no bad sectors',
    );
  }
  return out;
}

function legacyFailed(drive: Obj): boolean {
  return (
    typeof drive.smartStatus === 'string' && /fail/i.test(drive.smartStatus)
  );
}

function notMeasurable(
  reason: string,
  action: string,
  legacySmartFailed: boolean,
): DriveHealthView {
  const headline = `Not measurable — ${reason}`;
  return {
    kind: 'not-measurable',
    headline,
    // The report cell carries the action as well: an xlsx reader has no other
    // place to learn what to do about the drive.
    cell: `${headline} — ${action}`,
    percent: null,
    status: null,
    tone: 'warn',
    basis: null,
    action,
    reasons: [],
    facts: [],
    legacySmartFailed,
  };
}

// One drive (an element of profile.storage) -> what to show for its health.
export function driveHealthView(drive: unknown): DriveHealthView {
  const d = isObj(drive) ? drive : {};
  const failedBefore = legacyFailed(d);
  const h = d.health;

  if (!isObj(h) || typeof h.measured !== 'boolean') {
    return {
      kind: 'not-scanned',
      headline: NOT_SCANNED,
      cell: failedBefore
        ? `${NOT_SCANNED} (earlier scan: SMART FAILED)`
        : NOT_SCANNED,
      percent: null,
      status: null,
      tone: failedBefore ? 'bad' : 'neutral',
      basis: null,
      action: null,
      reasons: [],
      facts: [],
      legacySmartFailed: failedBefore,
    };
  }

  if (h.measured === false) {
    return notMeasurable(
      words(h.reason) ?? NO_REASON,
      words(h.action) ?? RESCAN,
      false,
    );
  }

  // measured: true. The percentage must be a real 0-100 reading; anything
  // else is not shown as a number (and not rounded or clamped into one).
  const raw = h.percent;
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    raw < 0 ||
    raw > 100
  ) {
    return notMeasurable(
      'the station sent a health reading that is not a valid percentage',
      RESCAN,
      false,
    );
  }
  const percent = Math.round(raw);
  const status = statusForPercent(percent);
  const label = STATUS_LABEL[status];
  return {
    kind: 'measured',
    headline: `${percent}% · ${label}`,
    cell: `${percent}% ${label}`,
    percent,
    status,
    tone: TONE[status],
    basis: words(h.basis) ?? "worked out from the drive's own SMART data",
    action: null,
    reasons: Array.isArray(h.reasons)
      ? h.reasons.map(words).filter((r): r is string => r != null)
      : [],
    facts: facts(h),
    legacySmartFailed: false,
  };
}

// The drives of a profile.storage value that are actual drive entries.
function drivesOf(storage: unknown): unknown[] {
  return Array.isArray(storage) ? storage.filter(isObj) : [];
}

// A drive's token inside a several-drive cell. Lower-case after the first,
// e.g. "2 drives: 45% Bad, not measurable (behind a RAID/Intel RST controller
// — set the storage mode to AHCI in the BIOS, then press Rescan)".
function token(v: DriveHealthView): string {
  if (v.kind === 'measured') return v.cell;
  if (v.kind === 'not-measurable')
    return `not measurable (${v.cell.slice('Not measurable — '.length)})`;
  return v.legacySmartFailed
    ? 'not scanned yet (earlier scan: SMART FAILED)'
    : 'not scanned yet';
}

// Worst first: a drive whose own (legacy) SMART verdict was FAILED - the drive
// itself said it is failing, the worst news there is - then measured drives
// from the lowest percentage up, then drives that could not be measured, then
// drives never scanned for health.
function rank(v: DriveHealthView): number {
  if (v.legacySmartFailed) return -1;
  if (v.kind === 'measured') return v.percent as number;
  return v.kind === 'not-measurable' ? 1000 : 2000;
}

// One report cell for a whole machine (profile.storage). '' when the device
// has no drives on record - a blank cell, exactly like a missing battery.
export function driveHealthSummary(storage: unknown): string {
  const views = drivesOf(storage).map(driveHealthView);
  if (views.length === 0) return '';
  if (views.length === 1) return views[0].cell;
  // Nothing to rank: say it once rather than "not scanned yet" per drive.
  if (views.every((v) => v.kind === 'not-scanned' && !v.legacySmartFailed)) {
    return `${views.length} drives: ${NOT_SCANNED}`;
  }
  const sorted = views
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i)
    .map(({ v }) => token(v));
  return `${views.length} drives: ${sorted.join(', ')}`;
}
