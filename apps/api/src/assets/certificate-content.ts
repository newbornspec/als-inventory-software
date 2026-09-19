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

function driveSection(
  d: DriveOutcome<AssetAudit>,
  index: number,
  count: number,
): CertificateSection {
  const r = d.row!;
  const att = wipeAttestation(sourceOf(r));
  const title =
    count > 1
      ? `Storage medium erased (${index + 1} of ${count})`
      : 'Storage medium erased';
  const rows: Row[] = [
    ['Model', d.model ?? '—'],
    ['Serial number', d.serialNumber ?? '—'],
    [
      'Method',
      (r.dataWipeMethod?.trim() || 'Not specified') + att.methodSuffix,
    ],
    [att.dateLabel, longDate(r.createdAt)],
  ];
  return { title, rows };
}

export function buildDeviceCertificate(
  asset: CertificateAsset,
  rollup: WipeRollup<AssetAudit>,
  certRow: AssetAudit,
): DeviceCertificate {
  const hp: Obj = (asset.hardwareProfile as Obj | null) ?? {};
  const ident: Obj = (hp.identification as Obj | undefined) ?? {};
  const storage = Array.isArray(hp.storage)
    ? (hp.storage as Obj[])
        .map((d) => [txt(d.capacity), txt(d.type)].filter(Boolean).join(' '))
        .filter(Boolean)
        .join(', ')
    : (certRow.storageCapacity ?? '');

  const source = sourceOf(certRow);
  const att = wipeAttestation(source);
  const drives = rollup.drives.filter((d) => d.row);

  const erasure: Row[] = [
    ['Result', att.result],
    ...erasurePeople(
      source,
      att,
      certRow.operatorName,
      certRow.auditedBy?.name ?? null,
    ),
  ];

  const extra: Row[] = [];
  if (certRow.cosmeticGrade)
    extra.push(['Cosmetic grade', pretty(certRow.cosmeticGrade)]);
  if (certRow.finalDisposition)
    extra.push(['Disposition', pretty(certRow.finalDisposition)]);

  return {
    certNo: certificateNumber(asset.id, certRow),
    intro: att.intro,
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
      ['Storage media', storage],
    ],
    erasure,
    drives: drives.map((d, i) => driveSection(d, i, drives.length)),
    notices: [],
    extra,
    footer: 'This certificate relates solely to the device identified above.',
  };
}
