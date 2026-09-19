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

function driveSection(
  d: DriveOutcome<AssetAudit>,
  index: number,
  count: number,
  snapshot: Obj,
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
    ['Result', att.result],
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
  const intro = manual
    ? att.intro
    : `This certifies that ${many ? 'each storage medium' : 'the storage medium'} identified below, in the device identified below, has been sanitised using the method stated, rendering previously stored data unrecoverable by generally available means.`;

  const erasure: Row[] = [
    ['Result', att.result],
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
    ],
    erasure,
    drives: drives.map((d, i) => driveSection(d, i, drives.length, snapshot)),
    notices: [],
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
