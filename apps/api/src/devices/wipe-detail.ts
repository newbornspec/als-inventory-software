import type { HardwareProfile } from './hardware-profile.type';

// The per-drive wipe detail a station sends with each record (remediation
// spec steps 19, 26, 39; the payload shape is contract C2 in the remediation
// brief), turned into what asset_audits stores.
//
// WHY THIS IS NOT CLASS-VALIDATOR. Every other ingest field is validated in
// the DTO, and a bad value answers 400. For these fields that would be wrong:
// a stick that gets a 400 queues the record and retries it forever, so one
// unexpected enum value from a newer engine (or one clock set to next year)
// would wedge that station's whole offline queue - and the wipe it describes
// would never be recorded at all. So the DTO only admits these fields
// (@Allow) and this function decides what to keep:
//   - an unknown enum value is stored NULL, with a note saying what came in;
//   - a wipedAt more than 5 minutes ahead of the server is stored NULL, with
//     a note: a station clock that far ahead cannot be trusted for the date
//     printed on a certificate;
//   - an oversized string is truncated to its column;
//   - a value of the wrong type is stored NULL, with a note.
// The record itself always files.

export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export const WIPED_AT_CLOCKS = ['network', 'unsynced'] as const;
export const METHODS_REQUESTED = [
  'auto',
  'crypto',
  'secure',
  'overwrite',
  'zero',
] as const;
export const SANITISATION_LEVELS = ['purge', 'clear', 'none'] as const;
export const VERIFICATIONS = ['clean', 'found', 'unverified'] as const;
export const HIDDEN_AREAS = [
  'none',
  'hpa-removed',
  'unknown',
  'dco-present',
  'hpa-present',
] as const;
export const LOCK_STATUSES = [
  'CLEAR',
  'LOCKED',
  'WARNING',
  'UNVERIFIED',
] as const;

const MAX_LIMITATIONS = 50;
const MAX_LIMITATION_LENGTH = 500;
// A value quoted back in a note is cut short: the note is for a person.
const QUOTE_LENGTH = 40;

export interface WipedDrive {
  serialNumber?: string;
  model?: string;
  sizeBytes?: number;
  transport?: string;
  rotational?: boolean;
  wwn?: string;
  devicePath?: string;
}

export interface WipeSmart {
  reallocatedBefore?: number;
  pendingBefore?: number;
  reallocatedAfter?: number;
  pendingAfter?: number;
}

// The raw, unvalidated fields as they arrive on the ingest DTO.
export interface WipeDetailInput {
  wipedAt?: unknown;
  wipeStartedAt?: unknown;
  wipedAtClock?: unknown;
  wipedDrive?: unknown;
  toolName?: unknown;
  toolVersion?: unknown;
  toolCommit?: unknown;
  methodRequested?: unknown;
  methodAttempted?: unknown;
  fallbackReason?: unknown;
  sanitisationLevel?: unknown;
  verification?: unknown;
  hiddenAreas?: unknown;
  wipeLimitations?: unknown;
  wipeSmart?: unknown;
}

// What lands on the asset_audits row (entity property names).
export interface WipeDetail {
  wipedAt: Date | null;
  wipeStartedAt: Date | null;
  wipedAtClock: string | null;
  wipedDriveSerial: string | null;
  wipedDrive: WipedDrive | null;
  toolName: string | null;
  toolVersion: string | null;
  toolCommit: string | null;
  wipeMethodRequested: string | null;
  wipeMethodAttempted: string | null;
  wipeFallbackReason: string | null;
  sanitisationLevel: string | null;
  wipeVerification: string | null;
  hiddenAreas: string | null;
  wipeLimitations: string[] | null;
  wipeSmart: WipeSmart | null;
}

const quote = (v: unknown): string => {
  let s: string;
  try {
    s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > QUOTE_LENGTH ? `${s.slice(0, QUOTE_LENGTH)}…` : s;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ISO-8601 with a time part, as the station sends (2026-09-19T10:01:07Z).
// Date.parse alone accepts things like "7" or "Sept 19".
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export function normaliseWipeDetail(
  input: WipeDetailInput,
  now: Date = new Date(),
): { detail: WipeDetail; notes: string[] } {
  const notes: string[] = [];
  const absent = (v: unknown) => v === undefined || v === null || v === '';

  const text = (field: string, v: unknown, max: number): string | null => {
    if (absent(v)) return null;
    if (typeof v !== 'string') {
      notes.push(`${field} ${quote(v)} was not text`);
      return null;
    }
    const t = v.trim();
    return t ? t.slice(0, max) : null;
  };

  const oneOf = (
    field: string,
    v: unknown,
    allowed: readonly string[],
  ): string | null => {
    if (absent(v)) return null;
    if (typeof v === 'string' && allowed.includes(v.trim())) return v.trim();
    notes.push(`${field} ${quote(v)} is not a known value`);
    return null;
  };

  const time = (field: string, v: unknown): Date | null => {
    if (absent(v)) return null;
    const d =
      typeof v === 'string' && ISO_DATETIME.test(v.trim())
        ? new Date(v.trim())
        : null;
    if (!d || Number.isNaN(d.getTime())) {
      notes.push(`${field} ${quote(v)} is not a date and time`);
      return null;
    }
    if (d.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
      notes.push(
        `${field} ${quote(v)} is in the future - the station clock is wrong`,
      );
      return null;
    }
    return d;
  };

  const count = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;

  let wipedDrive: WipedDrive | null = null;
  if (!absent(input.wipedDrive)) {
    if (!isObject(input.wipedDrive)) {
      notes.push(
        `wipedDrive ${quote(input.wipedDrive)} was not a drive description`,
      );
    } else {
      const d = input.wipedDrive;
      const drive: WipedDrive = {};
      const put = <K extends keyof WipedDrive>(
        k: K,
        v: WipedDrive[K] | null | undefined,
      ) => {
        if (v !== null && v !== undefined) drive[k] = v;
      };
      put('serialNumber', text('wipedDrive.serialNumber', d.serialNumber, 128));
      put('model', text('wipedDrive.model', d.model, 255));
      put('sizeBytes', count(d.sizeBytes));
      put('transport', text('wipedDrive.transport', d.transport, 32));
      put(
        'rotational',
        typeof d.rotational === 'boolean' ? d.rotational : undefined,
      );
      put('wwn', text('wipedDrive.wwn', d.wwn, 128));
      put('devicePath', text('wipedDrive.devicePath', d.devicePath, 64));
      wipedDrive = Object.keys(drive).length ? drive : null;
    }
  }

  let wipeLimitations: string[] | null = null;
  if (!absent(input.wipeLimitations)) {
    if (!Array.isArray(input.wipeLimitations)) {
      notes.push(
        `wipeLimitations ${quote(input.wipeLimitations)} was not a list`,
      );
    } else {
      // [] is kept as []: "the engine reported no limitations" is not the
      // same statement as "this stick predates limitations" (NULL).
      wipeLimitations = input.wipeLimitations
        .filter((l): l is string => typeof l === 'string' && l.trim() !== '')
        .slice(0, MAX_LIMITATIONS)
        .map((l) => l.trim().slice(0, MAX_LIMITATION_LENGTH));
    }
  }

  let wipeSmart: WipeSmart | null = null;
  if (!absent(input.wipeSmart)) {
    if (!isObject(input.wipeSmart)) {
      notes.push(
        `wipeSmart ${quote(input.wipeSmart)} was not a set of counters`,
      );
    } else {
      const s = input.wipeSmart;
      const smart: WipeSmart = {};
      for (const k of [
        'reallocatedBefore',
        'pendingBefore',
        'reallocatedAfter',
        'pendingAfter',
      ] as const) {
        const n = count(s[k]);
        if (n !== undefined) smart[k] = n;
      }
      wipeSmart = Object.keys(smart).length ? smart : null;
    }
  }

  const detail: WipeDetail = {
    wipedAt: time('wipedAt', input.wipedAt),
    wipeStartedAt: time('wipeStartedAt', input.wipeStartedAt),
    wipedAtClock: oneOf('wipedAtClock', input.wipedAtClock, WIPED_AT_CLOCKS),
    wipedDriveSerial: wipedDrive?.serialNumber ?? null,
    wipedDrive,
    toolName: text('toolName', input.toolName, 64),
    toolVersion: text('toolVersion', input.toolVersion, 64),
    toolCommit: text('toolCommit', input.toolCommit, 64),
    wipeMethodRequested: oneOf(
      'methodRequested',
      input.methodRequested,
      METHODS_REQUESTED,
    ),
    wipeMethodAttempted: text('methodAttempted', input.methodAttempted, 255),
    wipeFallbackReason: text('fallbackReason', input.fallbackReason, 255),
    sanitisationLevel: oneOf(
      'sanitisationLevel',
      input.sanitisationLevel,
      SANITISATION_LEVELS,
    ),
    wipeVerification: oneOf('verification', input.verification, VERIFICATIONS),
    hiddenAreas: oneOf('hiddenAreas', input.hiddenAreas, HIDDEN_AREAS),
    wipeLimitations,
    wipeSmart,
  };
  return { detail, notes };
}

// The line appended to the audit's notes when anything was set aside, so a
// person reading the record can see what the station actually sent.
export function wipeDetailNote(notes: string[]): string | null {
  if (!notes.length) return null;
  return `[Station record: ${notes.join('; ')}. Stored as not recorded.]`;
}

// The device-lock roll-up, derived on the SERVER from the hardware profile
// rather than trusted from a payload field, so every stick - including ones
// that predate this column - gets it. tools/hardware-audit.sh writes the
// roll-up to locks.status (from lock-checks.sh) and repeats it as
// security.lockStatus; the latter is the only one present when the lock
// detectors did not run (then it says UNVERIFIED). The migration's backfill
// (1752650000000-AddWipeRecordDetail) applies the same rule in SQL.
export function lockStatusOf(
  profile: HardwareProfile | null | undefined,
): string | null {
  if (!profile) return null;
  const security = isObject(profile.security) ? profile.security : {};
  const raw = profile.locks?.status ?? security.lockStatus;
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  return (LOCK_STATUSES as readonly string[]).includes(s) ? s : null;
}
