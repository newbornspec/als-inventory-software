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
// together. Now every record names its drive (wiped_drive_serial, and
// wiped_drive's model, size, WWN and device path - owner decision D18: a
// drive that reports no serial is still wiped and recorded), so:
//
//   1. rows are grouped by drive - see "Which records belong to which
//      drive" below for how, and for drives the records cannot tell apart;
//   2. each drive's CURRENT state is its latest row - a re-wipe of a drive
//      that failed supersedes the failure;
//   3. the machine is wiped only if EVERY drive's current state is wiped -
//      worst-first, so the order the rows arrived in cannot change the answer;
//   4. every internal drive any wipe-time hardware profile lists must have a
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
  // The profile's "512GB", in GB; null when not given or not readable.
  capacityGB?: number | null;
}

export type WipeVerdict = 'wiped' | 'failed' | 'incomplete' | 'none';
export type DriveStatus = 'wiped' | 'failed' | 'missing';

// Why the verdict is not 'wiped' ('none', 'incomplete' and 'failed' mirror
// the verdict; 'discard' and 'mixed' are failures with their own wording).
export type RollupReason =
  'none' | 'failed' | 'discard' | 'mixed' | 'incomplete' | 'unverifiable';

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
  // A 'missing' drive the profile lists alongside another it cannot be told
  // apart from (same serial, or no serial and the same model and size), so
  // the records cannot show which of them was wiped.
  ambiguous?: boolean;
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

// Does this row name its drive at all (serial or device path)? Null for a
// legacy or manual row. Grouping itself is done by perDrive below.
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

// A model name compared across records: case, spaces and punctuation vary
// between lsblk and the engine's own read, the drive does not.
const modelKey = (v: unknown): string | null => {
  const s = clean(v);
  return s ? s.toUpperCase().replace(/[^A-Z0-9]+/g, '') || null : null;
};

// "512GB" (what tools/hardware-audit.sh writes), "1TB", "476.9G" -> GB.
export function capacityGBOf(v: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT])(?:I?B)?$/i.exec(clean(v) ?? '');
  if (!m) return null;
  const unit: Record<string, number> = { K: 1e-6, M: 1e-3, G: 1, T: 1e3 };
  return parseFloat(m[1]) * unit[m[2].toUpperCase()];
}

// The internal drives a hardware profile lists. tools/hardware-audit.sh
// already leaves USB and removable media (the boot stick among them) out of
// storage[]; the same exclusions are applied here anyway, so a profile from
// another tool - or an older engine - cannot make the boot stick a drive
// that "was never wiped".
//
// Two more kinds of entry are not drives anyone can wipe, and the engine's
// profile loop does not drop them (it keeps every lsblk TYPE=disk that is
// not USB or removable; the kiosk's drive list and the engine's wipe refuse
// them by NAME, which storage[] does not carry). Counted as expected drives,
// each would hold its machine at 'incomplete' forever:
//   - pseudo-devices of the live session (zram swap, ram disks): no model,
//     no serial and no bus;
//   - an eMMC's hardware boot partitions (mmcblk0boot0/boot1): a few MB,
//     "0GB" in the profile, and the parent's serial - so with drives now
//     counted per serial they would read as two more drives of that serial.
// Nothing under 1 GB is user storage in any machine this station audits.
export function expectedDrivesOf(profile: unknown): ExpectedDrive[] {
  const storage = (profile as { storage?: unknown } | null | undefined)
    ?.storage;
  if (!Array.isArray(storage)) return [];
  const out: ExpectedDrive[] = [];
  for (const d of storage as unknown[]) {
    if (!d || typeof d !== 'object') continue;
    const drive = d as Record<string, unknown>;
    const bus = [drive.interface, drive.transport]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
    if (/\busb\b/i.test(`${bus} ${clean(drive.type) ?? ''}`)) continue;
    if (
      drive.removable === true ||
      drive.removable === 1 ||
      drive.removable === '1'
    )
      continue;
    const serialNumber = clean(drive.serialNumber);
    const model = clean(drive.model);
    if (!serialNumber && !model && !clean(bus)) continue;
    const capacityGB = capacityGBOf(drive.capacity);
    if (capacityGB !== null && capacityGB < 1) continue;
    out.push({ serialNumber, model, capacityGB });
  }
  return out;
}

// Which listed drives are the same kind of drive as far as a record can
// tell: the same serial, or - with no serial - the same model and size.
const expectedType = (e: ExpectedDrive) =>
  e.serialNumber
    ? `serial:${e.serialNumber.toUpperCase()}`
    : `noserial:${modelKey(e.model) ?? '?'}|${
        e.capacityGB == null ? '?' : Math.round(e.capacityGB)
      }`;

// The drives that must each have a wipe: every internal drive listed by ANY
// wipe-time profile since per-drive records began (the snapshot each station
// record carries - not asset.hardware_profile, which a later capture
// overwrites). A drive listed N times (two drives that report the same
// serial) must be there N times.
//
// The union, not just the latest profile: a drive that drops off the bus -
// a dying drive, an unseated cable - is missing from the next session's
// profile, and a re-wipe of the others then read as "every drive wiped"
// while that drive, never erased, was still in the machine (review, wave 2).
// A drive that really was taken out stays expected; the way past that is a
// hand record for the whole machine, which the certificate labels as manual.
export function expectedDrivesFromRows(rows: RollupRow[]): ExpectedDrive[] {
  const identified = rows.filter(
    (r) => isOutcome(r) && !isManualRow(r) && driveKey(r) && r.hardwareProfile,
  );
  // Newest first, so a tie keeps the newest profile's description.
  identified.sort((a, b) => compare(station, b, a));
  const best = new Map<string, ExpectedDrive[]>();
  for (const r of identified) {
    const byType = new Map<string, ExpectedDrive[]>();
    for (const e of expectedDrivesOf(r.hardwareProfile)) {
      const t = expectedType(e);
      byType.set(t, [...(byType.get(t) ?? []), e]);
    }
    for (const [t, list] of byType)
      if (list.length > (best.get(t)?.length ?? 0)) best.set(t, list);
  }
  return [...best.keys()].sort().flatMap((t) => best.get(t)!);
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

  // Legacy rows older (on both clocks) than the first per-drive record are
  // history; any later one is one more "drive" that can only make it worse.
  const eraStart = Math.min(
    ...identified.map((r) => Math.min(station(r), received(r))),
  );
  const lateLegacy = legacy.filter(
    (r) => station(r) >= eraStart || received(r) >= eraStart,
  );
  const drives = perDrive(identified, expectedDrives);
  if (lateLegacy.length) drives.push(outcomeFor(MACHINE_KEY, lateLegacy));
  const rolled = worst(drives);

  // The expectation is the whole reason "wiped" can mean "all of them". A
  // `missing` outcome - the only thing that produces 'incomplete' - can only
  // come from a drive that is IN expectedDrives. So an EMPTY expectation
  // produces no missing outcomes, and a machine whose drive list was never
  // read rolls up exactly like one where every drive is accounted for.
  //
  // That is this codebase's recurring failure at its most expensive point: an
  // absence of evidence read as evidence of absence, at the gate that issues
  // an erasure certificate. Reachable with no station bug at all - a wipe
  // posted without a profile, or a profile whose storage[] was dropped
  // because the enumeration returned nothing.
  //
  // Refusing here is the safe direction: it withholds a certificate until the
  // machine is audited again, rather than certifying a machine we never
  // looked at.
  if (rolled.verdict === 'wiped' && !expectationKnown(identified, expectedDrives))
    return {
      verdict: 'incomplete',
      reason: 'unverifiable',
      basis: 'drives',
      drives,
    };
  return rolled;
}

// Whether we actually KNOW which drives this machine has.
//
// An expectation with entries is knowledge. An empty one is knowledge only if
// a station row carried a storage list we read - and every entry in it was
// legitimately excluded as external or removable. Absent, unreadable or empty
// storage is not "this machine has no drives"; an empty storage[] is dropped
// from the profile whether the audit enumerated nothing or never ran.
function expectationKnown(
  identified: RollupRow[],
  expected: ExpectedDrive[],
): boolean {
  if (expected.length) return true;
  return identified.some((r) => {
    const storage = (
      r.hardwareProfile as { storage?: unknown } | null | undefined
    )?.storage;
    return Array.isArray(storage) && storage.length > 0;
  });
}

// --- Which records belong to which drive -------------------------------------
//
// A serial is a drive's identity, and a device path is not: /dev/sdX names
// are handed out in probe order at every boot, so the same drive can be sda
// in one session and sdb in the next, and a different drive can take its
// name (the kiosk's own comments on gui_wipe_one say the same). Keying
// unserialled drives by path (the first cut of D18) let a re-wipe of drive Y
// at X's old name hide X's failure, and let one drive wiped at two names
// count as two drives. And a serial is only an identity while it is unique:
// cheap drives can share a placeholder serial, and grouping by serial alone
// let a later wipe of one hide the other's failure (review, wave 2).
//
// So records are grouped by what the drive itself reports:
//   - its serial (with no serial: one group, "noserial");
//   - within that, its model (and, with no serial, its size to the GB), when
//     every record in the group carries it - a different model is a
//     different drive;
//   - its WWN, when every record in the group carries one: a WWN is unique
//     to the drive, so records with a WWN are told apart exactly.
// A group's latest record decides the drive only while the group is known
// to be ONE drive: it has a WWN; or it has a serial the wipe-time profiles
// list at most once; or, with no serial, exactly one listed drive matches
// it. Otherwise it may be several drives, and each device path's latest
// record counts - worst-first, so a failure at any path stands until that
// path is wiped again. Such a group covers ONE listed drive whatever it
// holds, because two paths do not prove two drives; a machine with two
// drives the records cannot tell apart is therefore never 'wiped' from the
// station's records alone (it stays 'incomplete', and the refusal says why).
// Owner-reversible policy: the way past it is a hand record for the whole
// machine, which the certificate labels as manual.

interface Identity {
  serial: string | null;
  model: string | null;
  gb: number | null;
  wwn: string | null;
}

function identityOf(r: RollupRow): Identity {
  const wd = r.wipedDrive ?? {};
  const serial = clean(r.wipedDriveSerial) ?? clean(wd.serialNumber);
  const size = typeof wd.sizeBytes === 'number' ? wd.sizeBytes : NaN;
  return {
    serial: serial ? serial.toUpperCase() : null,
    model: modelKey(wd.model),
    gb: size > 0 ? size / 1e9 : null,
    wwn: clean(wd.wwn)?.toLowerCase() ?? null,
  };
}

// Could this listed drive be the drive these records name? Anything either
// side does not report is no evidence against it.
function fits(e: ExpectedDrive, id: Identity): boolean {
  if (id.serial && e.serialNumber?.toUpperCase() !== id.serial) return false;
  if (!id.serial && e.serialNumber) return false;
  const m = modelKey(e.model);
  if (m && id.model && m !== id.model) return false;
  // The profile rounds to the GB ("%.0fGB").
  if (e.capacityGB != null && id.gb !== null)
    if (Math.abs(e.capacityGB - id.gb) > 0.51) return false;
  return true;
}

// Several drives may be behind these records: each device path's latest
// record, worst-first.
function perPathOutcome<R extends RollupRow>(
  key: string,
  rows: R[],
): DriveOutcome<R> {
  const byPath = new Map<string, R[]>();
  for (const r of rows) {
    const p = clean(r.wipedDrive?.devicePath) ?? '';
    byPath.set(p, [...(byPath.get(p) ?? []), r]);
  }
  const outcomes = [...byPath.keys()]
    .sort()
    .map((p) => outcomeFor(key, byPath.get(p)!));
  return (
    outcomes.find((o) => o.status === 'failed') ??
    outcomes.reduce((a, b) => (compare(station, b.row!, a.row!) > 0 ? b : a))
  );
}

function perDrive<R extends RollupRow>(
  identified: R[],
  expectedDrives: ExpectedDrive[],
): DriveOutcome<R>[] {
  const classOf = (id: Identity) =>
    id.serial ? `serial:${id.serial}` : 'noserial';
  const classes = new Map<string, R[]>();
  for (const r of identified) {
    const c = classOf(identityOf(r));
    classes.set(c, [...(classes.get(c) ?? []), r]);
  }
  const expectedIn = (c: string) =>
    expectedDrives.filter((e) =>
      c === 'noserial'
        ? !e.serialNumber
        : `serial:${e.serialNumber?.toUpperCase()}` === c,
    );
  const allClasses = new Set([
    ...classes.keys(),
    ...expectedDrives.map((e) =>
      e.serialNumber ? `serial:${e.serialNumber.toUpperCase()}` : 'noserial',
    ),
  ]);

  const drives: DriveOutcome<R>[] = [];
  let unlisted = 0;
  for (const c of [...allClasses].sort()) {
    const rows = classes.get(c) ?? [];
    const listed = expectedIn(c);
    const ids = rows.map(identityOf);
    const every = (f: (i: Identity) => unknown) =>
      ids.length > 0 && ids.every((i) => f(i) !== null);
    const useWwn = every((i) => i.wwn);
    const useModel = every((i) => i.model);
    const useSize = c === 'noserial' && every((i) => i.gb);

    const clusters = new Map<string, { id: Identity; rows: R[] }>();
    rows.forEach((r, n) => {
      const i = ids[n];
      const id: Identity = {
        serial: i.serial,
        model: useModel ? i.model : null,
        gb: useSize && i.gb !== null ? Math.round(i.gb) : null,
        wwn: useWwn ? i.wwn : null,
      };
      const sub = [
        id.model && `model:${id.model}`,
        id.gb !== null && `size:${Math.round(id.gb)}`,
        id.wwn && `wwn:${id.wwn}`,
      ]
        .filter(Boolean)
        .join('|');
      const cl = clusters.get(sub) ?? { id, rows: [] };
      cl.rows.push(r);
      clusters.set(sub, cl);
    });

    // Each cluster is a drive outcome; then each listed drive is matched to
    // at most one cluster that fits it (a cluster covers one drive at most).
    const outcomes: Array<{ id: Identity; d: DriveOutcome<R> }> = [];
    for (const sub of [...clusters.keys()].sort()) {
      const { id, rows: rs } = clusters.get(sub)!;
      const key =
        c === 'noserial'
          ? `drive:${sub || '?'}`
          : clusters.size === 1
            ? c
            : `${c}|${sub}`;
      const one =
        id.wwn !== null ||
        (c === 'noserial'
          ? listed.filter((e) => fits(e, id)).length === 1
          : listed.length <= 1);
      outcomes.push({
        id,
        d: one ? outcomeFor(key, rs) : perPathOutcome(key, rs),
      });
    }
    drives.push(...outcomes.map((o) => o.d));

    const used = new Set<number>();
    for (const e of listed) {
      // A serial listed once is matched by the serial alone, as before.
      const n = outcomes.findIndex(
        (o, i) =>
          !used.has(i) &&
          (c !== 'noserial' && listed.length === 1 ? true : fits(e, o.id)),
      );
      if (n >= 0) {
        used.add(n);
        continue;
      }
      const ambiguous =
        listed.filter((x) => expectedType(x) === expectedType(e)).length > 1 &&
        outcomes.some((o) => fits(e, o.id));
      drives.push({
        key: e.serialNumber
          ? outcomes.length === 0 && listed.length === 1
            ? c
            : `${c}#missing:${used.size + ++unlisted}`
          : `unlisted:${++unlisted}`,
        serialNumber: e.serialNumber,
        model: e.model,
        status: 'missing',
        row: null,
        manual: false,
        discard: false,
        unidentified: false,
        ambiguous,
      });
    }
  }
  return drives;
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
    case 'unverifiable':
      return (
        'This device was wiped, but the station never recorded which drives it has, so there is nothing to ' +
        'check the wipe against and no way to show that every internal drive was erased. That happens when a ' +
        'wipe was filed without a hardware profile, or when the drive enumeration returned nothing. ' +
        'No erasure certificate can be issued on that basis. Audit the device again with the ALS audit station ' +
        'so its drives are on record; if it genuinely was fully erased, record the erasure manually and the ' +
        'certificate will say it was entered manually.'
      );
    case 'incomplete': {
      const missing = r.drives.filter((d) => d.status === 'missing');
      return (
        `Not every drive in this device has been wiped: ${missing
          .map(driveLabel)
          .join(
            '; ',
          )} ${missing.length === 1 ? 'is' : 'are'} listed in a hardware profile captured when it was wiped, with no wipe on record, ` +
        'so the device may still hold data. No erasure certificate can be issued until every internal drive ' +
        'has been wiped with the ALS audit station.' +
        (missing.some((d) => d.ambiguous)
          ? ' Some of its drives cannot be told apart (they report the same serial number, or no serial number ' +
            'and the same model and size, and no WWN), so the station’s records cannot show that each of them ' +
            'was wiped. If they all were, record the erasure of this device manually; the certificate will say it was entered manually.'
          : '')
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
