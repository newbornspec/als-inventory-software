import {
  certificateBlock,
  latestWipe,
  MIXED_REFUSAL,
  type WipeRowLike,
} from '../assets/certificate-eligibility';
import { DISCARD_REFUSAL, isNotAnErase } from '../assets/wipe-method';
import type { WipedDrive } from './wipe-detail';

// Is this MACHINE erased? One answer, worked out per drive (remediation spec
// D-6, plan step 22). Used by the station ingest (the asset's audit status),
// both certificate routes, and GET /assets/:id/certificate-eligibility, which
// the web asset page and the kiosk read instead of re-implementing it.
//
// WHY PER DRIVE. The station files one record per drive. A two-drive laptop
// where drive A erased and drive B failed leaves a WIPED row and a FAILED
// row, and every rule that looks only at "the latest row" gets it wrong in
// one order or the other: the asset flipped to whichever outcome arrived
// last, and the certificate printed "data unrecoverable" for a machine whose
// second drive still held data. The interim guard (certificate-eligibility.ts,
// owner decision D11) could only guess from time which rows belonged
// together. Now every record names its drive (wiped_drive_serial, else
// wiped_drive.devicePath - owner decision D18: a drive that reports no serial
// is keyed by its device path), so:
//
//   1. rows are grouped by drive;
//   2. each drive's CURRENT state is its latest row - a re-wipe of a drive
//      that failed supersedes the failure;
//   3. the machine is wiped only if EVERY drive's current state is wiped -
//      worst-first, so the order the rows arrived in cannot change the answer;
//   4. every internal drive the wipe-time hardware profile lists must have a
//      wiped record, or the machine is 'incomplete' (a drive nobody tried to
//      wipe is not an erased drive).
//
// TWO CLOCKS, as in certificate-eligibility.ts: "latest" is taken by the
// station's time (wipedAt, else receipt time) AND by receipt time, and a
// drive counts as wiped only if its latest row on BOTH is a wipe. A station
// clock that is wrong can therefore never let an older wipe hide a newer
// failure of the same drive. Being wrong in that direction costs a re-wipe.
//
// Two kinds of row carry no drive identity:
//   - a hand-recorded (manual) row, typed into the web app. A manual row
//     newer than every station row speaks for the whole machine: a person
//     holding "Record Manual Wipe" said the machine was dealt with after the
//     station's attempts (a third-party tool, physical destruction). Allowed,
//     but labelled - the owner's standing pattern - and the certificate says
//     it was entered manually. An older manual row is superseded by the
//     station's per-drive records.
//   - a station row from a stick that predates per-drive records (legacy).
//     While a machine has only those, the interim D11 rule still decides
//     (certificate-eligibility.ts, unchanged). Once per-drive records exist,
//     legacy rows older than all of them are history; a legacy row filed
//     after them (an old stick used later) counts as one more "drive", keyed
//     "(machine)", and can only make the answer worse.
//
// DERIVED_RANK in devices.service.ts is untouched: this decides WHICH status
// the machine has earned; derivedMayReplace still decides whether it may
// replace what a person set.

export const MACHINE_KEY = '(machine)';

export interface RollupRow extends WipeRowLike {
  id?: string;
  wipedDriveSerial?: string | null;
  wipedDrive?: WipedDrive | null;
  wipeSource?: string | null;
  hardwareProfile?: unknown;
}

// An internal drive the wipe-time hardware profile lists.
export interface ExpectedDrive {
  serialNumber: string | null;
  model: string | null;
}

export type WipeVerdict = 'wiped' | 'failed' | 'incomplete' | 'none';
export type DriveStatus = 'wiped' | 'failed' | 'missing';

// Why the verdict is not 'wiped' ('none', 'incomplete' and 'failed' mirror
// the verdict; 'discard' and 'mixed' are failures with their own wording).
export type RollupReason =
  'none' | 'failed' | 'discard' | 'mixed' | 'incomplete';

export interface DriveOutcome<R extends RollupRow = RollupRow> {
  key: string;
  serialNumber: string | null;
  model: string | null;
  status: DriveStatus;
  // The row that decided this drive (latest by the station's clock); null
  // for a drive the profile lists that has no record at all.
  row: R | null;
  manual: boolean;
  // Its latest "wipe" was a block discard (TRIM), which is not an erase.
  discard: boolean;
  // No drive identity on the record: legacy or manual.
  unidentified: boolean;
}

export interface WipeRollup<R extends RollupRow = RollupRow> {
  verdict: WipeVerdict;
  reason: RollupReason | null;
  // How the answer was reached: per drive, by a manual record covering the
  // machine, by the interim rule for legacy rows, or nothing on record.
  basis: 'drives' | 'manual' | 'legacy' | 'none';
  drives: DriveOutcome<R>[];
}

type Clock = (r: RollupRow) => number;
const station: Clock = (r) => new Date(r.wipedAt ?? r.createdAt).getTime();
const received: Clock = (r) => new Date(r.createdAt).getTime();

const isOutcome = (r: RollupRow) =>
  r.dataWipeStatus === 'wiped' || r.dataWipeStatus === 'failed';

// Same rule as sourceOf in assets/manual-wipe.ts (kept inline so this file
// stays free of the Nest/permissions imports that one carries): a recorded
// source wins; an older row with a hardware profile came from the station.
export function isManualRow(r: RollupRow): boolean {
  if (r.wipeSource === 'station' || r.wipeSource === 'manual')
    return r.wipeSource === 'manual';
  return !r.hardwareProfile;
}

const clean = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

// The key a row is grouped by: its drive's serial, else its device path.
// Null for a row that names no drive.
export function driveKey(r: RollupRow): string | null {
  const serial = clean(r.wipedDriveSerial) ?? clean(r.wipedDrive?.serialNumber);
  if (serial) return `serial:${serial.toUpperCase()}`;
  const path = clean(r.wipedDrive?.devicePath);
  return path ? `path:${path}` : null;
}

// A total order, so the input's array order never matters. Ties on both
// clocks put a FAILED row "later" - worst-first - and then fall back to
// fields that are the same whatever order the rows came in.
function compare(clock: Clock, a: RollupRow, b: RollupRow): number {
  const other = clock === station ? received : station;
  return (
    clock(a) - clock(b) ||
    other(a) - other(b) ||
    (a.dataWipeStatus === 'failed' ? 1 : 0) -
      (b.dataWipeStatus === 'failed' ? 1 : 0) ||
    String(a.dataWipeMethod ?? '').localeCompare(
      String(b.dataWipeMethod ?? ''),
    ) ||
    String(a.id ?? '').localeCompare(String(b.id ?? ''))
  );
}

function latestOf<R extends RollupRow>(clock: Clock, rows: R[]): R {
  return rows.reduce((best, r) => (compare(clock, r, best) > 0 ? r : best));
}

const isErase = (r: RollupRow) =>
  r.dataWipeStatus === 'wiped' && !isNotAnErase(r.dataWipeMethod);

// The internal drives a hardware profile lists. tools/hardware-audit.sh
// already leaves USB and removable media (the boot stick among them) out of
// storage[]; the same exclusions are applied here anyway, so a profile from
// another tool - or an older engine - cannot make the boot stick a drive
// that "was never wiped".
export function expectedDrivesOf(profile: unknown): ExpectedDrive[] {
  const storage = (profile as { storage?: unknown } | null | undefined)
    ?.storage;
  if (!Array.isArray(storage)) return [];
  const out: ExpectedDrive[] = [];
  for (const d of storage as unknown[]) {
    if (!d || typeof d !== 'object') continue;
    const drive = d as Record<string, unknown>;
    const bus = [drive.interface, drive.transport, drive.type]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
    if (/\busb\b/i.test(bus)) continue;
    if (
      drive.removable === true ||
      drive.removable === 1 ||
      drive.removable === '1'
    )
      continue;
    out.push({
      serialNumber: clean(drive.serialNumber),
      model: clean(drive.model),
    });
  }
  return out;
}

// The wipe-time profile the expected drives come from: the snapshot on the
// latest station row that names its drive (each station record carries the
// profile captured for that wipe session). Not asset.hardware_profile, which
// a later capture overwrites.
export function expectedDrivesFromRows(rows: RollupRow[]): ExpectedDrive[] {
  const identified = rows.filter(
    (r) => isOutcome(r) && !isManualRow(r) && driveKey(r) && r.hardwareProfile,
  );
  if (!identified.length) return [];
  return expectedDrivesOf(latestOf(station, identified).hardwareProfile);
}

function outcomeFor<R extends RollupRow>(
  key: string,
  rows: R[],
): DriveOutcome<R> {
  const byStation = latestOf(station, rows);
  const byReceipt = latestOf(received, rows);
  const discard = [byStation, byReceipt].some(
    (r) => r.dataWipeStatus === 'wiped' && isNotAnErase(r.dataWipeMethod),
  );
  const wiped = isErase(byStation) && isErase(byReceipt);
  const drive = byStation.wipedDrive ?? null;
  return {
    key,
    serialNumber:
      clean(byStation.wipedDriveSerial) ?? clean(drive?.serialNumber),
    model: clean(drive?.model),
    status: wiped ? 'wiped' : 'failed',
    row: byStation,
    manual: isManualRow(byStation),
    discard,
    unidentified: key === MACHINE_KEY,
  };
}

function worst<R extends RollupRow>(drives: DriveOutcome<R>[]): WipeRollup<R> {
  const failed = drives.filter((d) => d.status === 'failed');
  if (failed.length) {
    return {
      verdict: 'failed',
      reason: failed.every((d) => d.discard) ? 'discard' : 'failed',
      basis: 'drives',
      drives,
    };
  }
  if (drives.some((d) => d.status === 'missing'))
    return {
      verdict: 'incomplete',
      reason: 'incomplete',
      basis: 'drives',
      drives,
    };
  return { verdict: 'wiped', reason: null, basis: 'drives', drives };
}

export function rollupWipe<R extends RollupRow>(
  input: R[],
  expectedDrives: ExpectedDrive[] = [],
): WipeRollup<R> {
  const rows = input.filter(isOutcome);
  if (!rows.length)
    return { verdict: 'none', reason: 'none', basis: 'none', drives: [] };

  const manual = rows.filter(isManualRow);
  const stationRows = rows.filter((r) => !isManualRow(r));
  const identified = stationRows.filter((r) => driveKey(r));
  const legacy = stationRows.filter((r) => !driveKey(r));

  // A manual record newer than every station record, on both clocks,
  // speaks for the whole machine - once per-drive records exist. While a
  // machine has only rows with no drive identity (legacy station rows and
  // manual rows), the wave-1 D11 rule below decides for all of them, exactly
  // as it did before: a manual "wiped" typed within 24 hours after a legacy
  // station failure stays refused, as it was. Letting the manual row win
  // there would have quietly loosened the interim rule for old records.
  if (manual.length && identified.length) {
    const m = latestOf(station, manual);
    const newest = stationRows.every(
      (s) => compare(station, m, s) > 0 && compare(received, m, s) > 0,
    );
    if (newest) {
      const d = outcomeFor(MACHINE_KEY, [m]);
      const drives = [{ ...d, manual: true }];
      return d.status === 'wiped'
        ? { verdict: 'wiped', reason: null, basis: 'manual', drives }
        : {
            verdict: 'failed',
            reason: d.discard ? 'discard' : 'failed',
            basis: 'manual',
            drives,
          };
    }
  }

  // Only rows with no drive identity: the interim D11 rule, exactly as in
  // wave 1 (manual rows included, as they were then).
  if (!identified.length) {
    const pool = [...legacy, ...manual];
    const block = certificateBlock(pool);
    const pick = (latestWipe(pool) as R | null) ?? latestOf(station, pool);
    const drive: DriveOutcome<R> = {
      key: MACHINE_KEY,
      serialNumber: null,
      model: null,
      status: block === null ? 'wiped' : 'failed',
      row: pick,
      manual: isManualRow(pick),
      discard: block === 'discard',
      unidentified: true,
    };
    if (block === null)
      return {
        verdict: 'wiped',
        reason: null,
        basis: 'legacy',
        drives: [drive],
      };
    if (block === 'none')
      // Only failures on record: nothing was ever erased.
      return {
        verdict: 'failed',
        reason: 'failed',
        basis: 'legacy',
        drives: [drive],
      };
    return {
      verdict: 'failed',
      reason: block,
      basis: 'legacy',
      drives: [drive],
    };
  }

  // Per drive.
  const groups = new Map<string, R[]>();
  for (const r of identified) {
    const k = driveKey(r)!;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  // Legacy rows older (on both clocks) than the first per-drive record are
  // history; any later one is one more "drive" that can only make it worse.
  const eraStart = Math.min(
    ...identified.map((r) => Math.min(station(r), received(r))),
  );
  const lateLegacy = legacy.filter(
    (r) => station(r) >= eraStart || received(r) >= eraStart,
  );
  const keys = [...groups.keys()].sort();
  const drives: DriveOutcome<R>[] = keys.map((k) =>
    outcomeFor(k, groups.get(k)!),
  );
  if (lateLegacy.length) drives.push(outcomeFor(MACHINE_KEY, lateLegacy));

  // Every internal drive the wipe-time profile lists must have a record.
  // With a serial: matched by serial. Without one (owner decision D18), the
  // drive was keyed by its device path at wipe time, so each unserialled
  // listed drive needs one path-keyed record.
  const recorded = new Set(
    drives.map((d) => d.serialNumber?.toUpperCase()).filter(Boolean),
  );
  const pathKeyed = drives.filter((d) => d.key.startsWith('path:')).length;
  let unserialled = 0;
  for (const e of expectedDrives) {
    if (e.serialNumber) {
      if (recorded.has(e.serialNumber.toUpperCase())) continue;
      drives.push({
        key: `serial:${e.serialNumber.toUpperCase()}`,
        serialNumber: e.serialNumber,
        model: e.model,
        status: 'missing',
        row: null,
        manual: false,
        discard: false,
        unidentified: false,
      });
    } else if (++unserialled > pathKeyed) {
      drives.push({
        key: `unlisted:${unserialled}`,
        serialNumber: null,
        model: e.model,
        status: 'missing',
        row: null,
        manual: false,
        discard: false,
        unidentified: false,
      });
    }
  }
  return worst(drives);
}

// How a drive is named in a sentence.
export function driveLabel(d: DriveOutcome): string {
  if (d.unidentified) return 'a drive not individually recorded';
  const what = d.model ? `${d.model} ` : '';
  return d.serialNumber
    ? `${what}(serial ${d.serialNumber})`
    : `${what}(serial not reported by the drive${
        d.row?.wipedDrive?.devicePath ? `, ${d.row.wipedDrive.devicePath}` : ''
      })`.trim();
}

export const NO_WIPE_REFUSAL =
  'No completed data erasure on record for this device — record an audit with data-wipe status "Wiped" first.';

// Why no certificate can be issued, in words, or null when one can. The same
// sentence goes to the certificate route's 400, the eligibility endpoint and
// so to the web page and the kiosk.
export function refusalFor(r: WipeRollup): string | null {
  switch (r.reason) {
    case null:
      return null;
    case 'none':
      return NO_WIPE_REFUSAL;
    case 'discard':
      return DISCARD_REFUSAL;
    case 'mixed':
      return MIXED_REFUSAL;
    case 'incomplete': {
      const missing = r.drives.filter((d) => d.status === 'missing');
      return (
        `Not every drive in this device has been wiped: ${missing
          .map(driveLabel)
          .join(
            '; ',
          )} ${missing.length === 1 ? 'is' : 'are'} listed in its hardware profile with no wipe on record, ` +
        'so the device may still hold data. No erasure certificate can be issued until every internal drive ' +
        'has been wiped with the ALS audit station.'
      );
    }
    case 'failed': {
      const failed = r.drives.filter((d) => d.status === 'failed');
      if (
        r.basis === 'legacy' &&
        failed.every((d) => !d.row || d.row.dataWipeStatus === 'failed')
      )
        return NO_WIPE_REFUSAL;
      return (
        `A drive in this device failed its wipe and has not been wiped successfully since: ${failed
          .map(driveLabel)
          .join(
            '; ',
          )}. The device may still hold data, so no erasure certificate can be issued. ` +
        'Wipe that drive again with the ALS audit station.'
      );
    }
  }
}
