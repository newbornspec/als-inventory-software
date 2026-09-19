import type { AssetAudit } from './asset-audit.entity';
import { erasurePeople } from './certificate-people';
import { sourceOf, wipeAttestation } from './manual-wipe';
import type { DriveOutcome, WipeRollup } from '../devices/wipe-rollup';

// WHAT a device's Certificate of Data Erasure says, worked out as plain data
// before anything is drawn. certificates.service.ts only lays this out on the
// page, so every sentence the certificate prints can be tested without
// parsing a PDF (PDF text is compressed), and the tests assert on exactly
// what the renderer was handed.
//
// ONE certificate per machine (owner decision D23), listing every drive the
// roll-up counted (devices/wipe-rollup.ts), each with its own serial, model,
// method and date. A two-drive laptop used to get a certificate that named
// no drive at all and implied both were erased because one was.

export type Row = [string, string];

export interface CertificateSection {
  title: string;
  rows: Row[];
}

export interface DeviceCertificate {
  certNo: string;
  intro: string;
  device: Row[];
  erasure: Row[];
  drives: CertificateSection[];
  // Sentences printed on their own under the drive sections.
  notices: string[];
  extra: Row[];
  footer: string;
}

// The parts of the asset the certificate reads.
export interface CertificateAsset {
  id: string;
  tag: string;
  name?: string | null;
  serialNumber?: string | null;
  deviceType?: string | null;
  category?: string | null;
  hardwareProfile?: unknown;
}

type Obj = Record<string, unknown>;

// A profile field as text for a certificate line ('' when absent or not text).
const txt = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

export const LONG_DATE: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
};
export const longDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-GB', LONG_DATE);

// The certificate number, derived EXACTLY as it always has been - from the
// receipt time of the wipe row the certificate used to be issued from (the
// latest WIPED row by the station's clock: latestWipe) and the asset id - so
// a certificate re-downloaded today carries the number it was issued with.
export function certificateNumber(
  assetId: string,
  certRow: { createdAt: Date | string },
): string {
  const d = new Date(certRow.createdAt);
  return `ERA-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate(),
  ).padStart(2, '0')}-${assetId.slice(0, 8).toUpperCase()}`;
}

// The lot certificate's line for devices it left off because a drive failed
// and was not wiped since, or was never wiped - the same job as
// discardedNotice (wipe-method.ts) and mixedNotice (certificate-eligibility.ts).
export function unfinishedNotice(n: number): string {
  return `${n} further device${n === 1 ? '' : 's'} in this lot ${n === 1 ? 'is' : 'are'} not listed: ${
    n === 1 ? 'it has' : 'each has'
  } a drive that failed its wipe, or was never wiped, and has not been wiped successfully since, so ${
    n === 1 ? 'it' : 'they'
  } may still hold data. ${n === 1 ? 'It is' : 'They are'} not certified by this document.`;
}

function pretty(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Owner decision D20: a record from before per-drive tracking keeps its
// certificate, but says plainly that it does not name the drive.
export const LEGACY_DRIVE =
  'Drive not individually recorded (record predates per-drive tracking)';
export const MANUAL_DRIVE =
  'Not individually recorded (the erasure was entered manually for the whole device)';
// Owner decision D18: a drive that reports no serial is still wiped, and the
// certificate says so rather than printing a blank.
export const NO_SERIAL = 'serial not reported by the drive';
export const CLOCK_NOTE =
  "The station's clock was not confirmed as network-synchronised when it wiped this drive; the date is the station's own.";

// "512GB", as the station's hardware profile writes capacities.
function capacityOf(bytes: number | undefined): string | undefined {
  return typeof bytes === 'number' && bytes > 0
    ? `${Math.round(bytes / 1e9)}GB`
    : undefined;
}

const TRANSPORTS: Record<string, string> = {
  nvme: 'NVMe',
  sata: 'SATA',
  ata: 'SATA',
  sas: 'SAS',
  scsi: 'SCSI',
  mmc: 'eMMC',
  usb: 'USB',
};

function interfaceOf(
  transport: string | undefined,
  rotational: boolean | undefined,
): string | undefined {
  if (!transport) return undefined;
  const bus =
    TRANSPORTS[transport.toLowerCase()] ?? transport.trim().toUpperCase();
  if (bus === 'NVMe' || rotational === undefined) return bus;
  return `${bus} ${rotational ? 'HDD' : 'SSD'}`;
}

// The wipe-time hardware profile's entry for a drive, matched by serial - the
// fallback for drive details an older stick did not send with the record.
function profileEntry(profile: Obj, serial: string | null): Obj | undefined {
  if (!serial || !Array.isArray(profile.storage)) return undefined;
  return (profile.storage as Obj[]).find(
    (s) => txt(s.serialNumber)?.toUpperCase() === serial.toUpperCase(),
  );
}

// The date a drive's section prints. The station's own time for the wipe
// ("Date performed") when the record carries it; otherwise - legacy and
// manual records - the time the record reached the server, labelled as what
// it is ("Date recorded"): an offline-queued record can arrive days after
// the wipe, so receipt time is not a wipe date.
function dateRows(r: AssetAudit): Row[] {
  if (sourceOf(r) === 'station' && r.wipedAt) {
    const rows: Row[] = [['Date performed', longDate(r.wipedAt)]];
    if (r.wipedAtClock !== 'network') rows.push(['Clock', CLOCK_NOTE]);
    return rows;
  }
  return [['Date recorded', longDate(r.createdAt)]];
}

// --- What the erasure achieved (plan step 39) -------------------------------
//
// Wave 1 stores, per drive, the NIST SP 800-88 level reached, what was asked
// for and what was tried, why a stronger method was not used, the read-back
// result, the hidden-area (HPA/DCO) outcome, the limitations the engine
// reported and the device-lock state. The certificate prints them. A field the
// record does not carry (an older stick, a legacy row) prints "Not assessed" -
// never a guess.
export const NOT_ASSESSED = 'Not assessed';

const LEVELS: Record<string, string> = {
  purge: 'Purge (NIST SP 800-88)',
  clear: 'Clear (NIST SP 800-88)',
  none: 'None — not sanitised to a NIST SP 800-88 level',
};
const REQUESTED: Record<string, string> = {
  auto: 'Automatic (the strongest the drive supports)',
  crypto: 'Cryptographic erase',
  secure: 'Firmware secure erase',
  overwrite: 'Overwrite',
  zero: 'Zero fill',
};
const FALLBACKS: Record<string, string> = {
  frozen: 'The drive was security-frozen by the firmware',
  unsupported: 'Not supported by the drive',
  tool_missing: 'The erase tool was not available on the station',
  verify_failed: 'The read-back check of the stronger method failed',
};
const VERIFICATIONS: Record<string, string> = {
  clean: 'Read back — no residual data found',
  found: 'Read back — data was still found',
  unverified: 'Not verified by read-back',
};
const HIDDEN: Record<string, string> = {
  none: 'None present',
  'hpa-removed':
    'Host Protected Area found, removed for the erase (temporarily) and erased',
  unknown: 'Could not be checked',
  'dco-present': 'Device Configuration Overlay present',
  'hpa-present': 'Host Protected Area present',
};
const LOCKS: Record<string, string> = {
  CLEAR: 'No lock detected',
  LOCKED: 'LOCKED — see the note below',
  WARNING: 'Possible lock — check before resale',
  UNVERIFIED: 'Could not be fully checked',
};

// Owner decision D39: a LOCKED device may still be certified as erased; the
// lock is printed on it, because the buyer needs to know.
export const LOCK_NOTICE =
  'Device lock: this device reported an ownership or firmware lock (for example a firmware password, a ' +
  'remote-management enrolment or an anti-theft service) when it was audited. The lock is separate from the ' +
  'data erasure certified here: the erasure did not remove it, and the device may not be usable by a new owner ' +
  'until it is released.';

export const QUALIFIED_RESULT =
  'Wiped — with limitations (see the limitations recorded below)';

export const UNQUALIFIED_DRIVE_RESULT =
  'Wiped — no limitations recorded for this drive';

const known = (map: Record<string, string>, v: string | null | undefined) =>
  v ? (map[v] ?? v) : NOT_ASSESSED;

// Did the engine record ANY reason to doubt "unrecoverable" for this drive?
// Any limitation does (spec step 39); so does a level of 'none' or a
// read-back that still found data - which should never come with 'wiped', but
// if it ever does, the certificate must not say unrecoverable.
export function isQualified(r: AssetAudit): boolean {
  return (
    (Array.isArray(r.wipeLimitations) && r.wipeLimitations.length > 0) ||
    r.sanitisationLevel === 'none' ||
    r.wipeVerification === 'found'
  );
}

function achievedRows(r: AssetAudit): Row[] {
  // A record from an engine that reports these fields at all: there, "no
  // fallback reason" means no fallback, not "not assessed".
  const reporting = !!(r.wipeMethodRequested || r.toolVersion);
  const limitations = Array.isArray(r.wipeLimitations)
    ? r.wipeLimitations.length
      ? r.wipeLimitations.join('\n')
      : 'None reported'
    : NOT_ASSESSED;
  return [
    ['Sanitisation level', known(LEVELS, r.sanitisationLevel)],
    ['Method requested', known(REQUESTED, r.wipeMethodRequested)],
    [
      'Fallback reason',
      r.wipeFallbackReason
        ? known(FALLBACKS, r.wipeFallbackReason)
        : reporting
          ? 'None'
          : NOT_ASSESSED,
    ],
    ['Verification', known(VERIFICATIONS, r.wipeVerification)],
    ['Hidden areas (HPA/DCO)', known(HIDDEN, r.hiddenAreas)],
    ['Limitations', limitations],
  ];
}

// The lot certificate's line when some listed devices carry limitations: the
// lot's lead sentence (manual-wipe.ts) says "unrecoverable" for station
// wipes, and must not be read as covering those rows.
export function limitationsNotice(n: number): string {
  return `${n} listed device${n === 1 ? ' is' : 's are'} marked "(limitations recorded)": limitations were recorded for ${
    n === 1 ? 'its' : 'their'
  } erasure, so ${n === 1 ? 'it is' : 'they are'} not covered by the statement that previously stored data is unrecoverable. ${
    n === 1 ? 'Its' : 'Their'
  } individual certificate${n === 1 ? ' lists' : 's list'} the limitations.`;
}

function driveSection(
  d: DriveOutcome<AssetAudit>,
  index: number,
  count: number,
  snapshot: Obj,
  // Limitations were recorded on some drive of this machine.
  qualified: boolean,
): CertificateSection {
  const r = d.row!;
  const source = sourceOf(r);
  const att = wipeAttestation(source);
  const title =
    count > 1
      ? `Storage medium erased (${index + 1} of ${count})`
      : 'Storage medium erased';
  const identity: Row[] = [];
  if (d.unidentified) {
    identity.push(['Drive', source === 'manual' ? MANUAL_DRIVE : LEGACY_DRIVE]);
  } else {
    const wd = r.wipedDrive ?? {};
    const listed = profileEntry(snapshot, d.serialNumber);
    identity.push(
      ['Model', txt(wd.model) ?? d.model ?? txt(listed?.model) ?? '—'],
      ['Serial number', d.serialNumber ?? NO_SERIAL],
      ['Capacity', capacityOf(wd.sizeBytes) ?? txt(listed?.capacity) ?? '—'],
      [
        'Interface',
        interfaceOf(txt(wd.transport), wd.rotational) ??
          txt(listed?.interface) ??
          '—',
      ],
    );
  }
  const rows: Row[] = [
    ...identity,
    [
      'Method',
      (r.dataWipeMethod?.trim() || 'Not specified') + att.methodSuffix,
    ],
    [
      'Result',
      source !== 'station'
        ? att.result
        : isQualified(r)
          ? QUALIFIED_RESULT
          : qualified
            ? // Any limitation on the machine removes "unrecoverable" from
              // the whole certificate, this drive's line included.
              UNQUALIFIED_DRIVE_RESULT
            : att.result,
    ],
    ...(source === 'station' ? achievedRows(r) : []),
    ...dateRows(r),
    ...erasurePeople(source, att, r.operatorName, r.auditedBy?.name ?? null),
  ];
  return { title, rows };
}

// The station row whose hardware profile is the machine AS IT WAS WIPED: the
// latest (by the station's clock) of the rows the certificate lists. Not
// asset.hardware_profile, which the next capture overwrites - a drive fitted
// after the wipe must not appear on the wipe's certificate.
function snapshotRow(
  drives: DriveOutcome<AssetAudit>[],
): AssetAudit | undefined {
  const withProfile = drives
    .map((d) => d.row)
    .filter((r): r is AssetAudit => !!r && sourceOf(r) === 'station')
    .filter((r) => r.hardwareProfile && typeof r.hardwareProfile === 'object');
  const time = (r: AssetAudit) => new Date(r.wipedAt ?? r.createdAt).getTime();
  return withProfile.sort((a, b) => time(b) - time(a))[0];
}

export function buildDeviceCertificate(
  asset: CertificateAsset,
  rollup: WipeRollup<AssetAudit>,
  certRow: AssetAudit,
): DeviceCertificate {
  const drives = rollup.drives.filter((d) => d.row);
  const snap = snapshotRow(drives);
  const snapshot: Obj = (snap?.hardwareProfile as Obj | undefined) ?? {};
  // Identity falls back to the asset's current profile (the machine is the
  // same machine); the storage line never does.
  const current: Obj = (asset.hardwareProfile as Obj | null) ?? {};
  const ident: Obj =
    (snapshot.identification as Obj | undefined) ??
    (current.identification as Obj | undefined) ??
    {};
  const storage = Array.isArray(snapshot.storage)
    ? (snapshot.storage as Obj[])
        .map((d) => [txt(d.capacity), txt(d.type)].filter(Boolean).join(' '))
        .filter(Boolean)
        .join(', ')
    : (certRow.storageCapacity ?? '');

  // Manual wording only when every drive the certificate lists rests on a
  // hand record (a manual record covering the machine). certRow can be a
  // manual row that the station's per-drive records superseded; it only
  // supplies the certificate number.
  const manual =
    drives.length > 0 && drives.every((d) => sourceOf(d.row!) === 'manual');
  const att = wipeAttestation(manual ? 'manual' : 'station');
  const many = drives.length > 1;
  // A hand-recorded erasure keeps manual-wipe.ts's own wording. A station
  // erasure now certifies the storage media it names, not "the data-storage
  // media contained in the device" - which on a legacy record, or a machine
  // with a drive fitted after the wipe, claimed drives nobody had erased.
  // Any limitation on any drive removes "unrecoverable" from the whole
  // certificate (spec step 39), not just from that drive's section.
  const qualified =
    !manual &&
    drives.some((d) => sourceOf(d.row!) === 'station' && isQualified(d.row!));
  const which = many ? 'each storage medium' : 'the storage medium';
  const intro = manual
    ? att.intro
    : qualified
      ? `This certifies that ${which} identified below, in the device identified below, has been sanitised using the method stated. Limitations were recorded for this erasure and are listed below; this certificate therefore makes no claim that previously stored data cannot be recovered.`
      : `This certifies that ${which} identified below, in the device identified below, has been sanitised using the method stated, rendering previously stored data unrecoverable by generally available means.`;

  // The device-lock state as the station found it when it wiped (D39).
  const lockStatus =
    snap?.lockStatus ??
    drives.map((d) => d.row!.lockStatus).find(Boolean) ??
    null;

  const erasure: Row[] = [
    ['Result', qualified ? QUALIFIED_RESULT : att.result],
    ['Storage media erased', String(drives.length)],
  ];

  const extra: Row[] = [];
  if (certRow.cosmeticGrade)
    extra.push(['Cosmetic grade', pretty(certRow.cosmeticGrade)]);
  if (certRow.finalDisposition)
    extra.push(['Disposition', pretty(certRow.finalDisposition)]);

  return {
    certNo: certificateNumber(asset.id, certRow),
    intro,
    device: [
      ['Manufacturer', txt(ident.manufacturer) ?? certRow.manufacturer ?? ''],
      ['Model', txt(ident.model) ?? certRow.model ?? asset.name ?? ''],
      [
        'Device type',
        asset.deviceType ?? txt(ident.deviceType) ?? asset.category ?? '',
      ],
      [
        'Serial number',
        asset.serialNumber ??
          txt(ident.serialNumber) ??
          certRow.serialNumber ??
          asset.tag,
      ],
      ['Asset tag', asset.tag],
      ['Storage fitted', storage],
      ['Device lock', known(LOCKS, lockStatus)],
    ],
    erasure,
    drives: drives.map((d, i) =>
      driveSection(d, i, drives.length, snapshot, qualified),
    ),
    notices: lockStatus === 'LOCKED' ? [LOCK_NOTICE] : [],
    extra,
    footer: `This certificate relates solely to the storage ${
      many ? 'media' : 'medium'
    } identified above, in the device identified above.`,
  };
}

// One lot-certificate row's drive column: every drive the machine's
// certificate lists, by serial.
export function driveSerialsOf(rollup: WipeRollup<AssetAudit>): string {
  return rollup.drives
    .filter((d) => d.row)
    .map((d) =>
      d.unidentified
        ? 'Not individually recorded'
        : (d.serialNumber ?? 'Serial not reported'),
    )
    .join(', ');
}

// The lot row's storage line, from the same wipe-time snapshot.
export function storageFittedOf(
  rollup: WipeRollup<AssetAudit>,
  certRow: AssetAudit,
): string {
  const snap = snapshotRow(rollup.drives.filter((d) => d.row));
  const snapshot: Obj = (snap?.hardwareProfile as Obj | undefined) ?? {};
  return Array.isArray(snapshot.storage)
    ? (snapshot.storage as Obj[])
        .map((d) => [txt(d.capacity), txt(d.type)].filter(Boolean).join(' '))
        .filter(Boolean)
        .join(', ')
    : (certRow.storageCapacity ?? '');
}
