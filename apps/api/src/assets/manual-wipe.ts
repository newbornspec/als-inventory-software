import { ForbiddenException } from '@nestjs/common';
import { PermissionsService } from '../auth/permissions.service';
import { UserRole } from '../users/user.entity';
import type { AssetAudit } from './asset-audit.entity';

// Who recorded a wipe outcome - and therefore what a certificate may say.
//
//   station - filed by the ALS audit station, which erased the drive and read
//             it back itself.
//   manual  - typed into the web app by a person: after a third-party wipe
//             tool, a physical destruction, or anything else the station did
//             not do. Allowed (the owner's decision, 19 Sep 2026), but only
//             with its own permission, and the certificate says so plainly.
//
// Before this, a hand-typed "Wiped" produced a certificate word-for-word the
// same as a station wipe: "rendering previously stored data unrecoverable".
export type WipeSource = 'station' | 'manual';

export const RECORD_MANUAL_WIPE = 'record_manual_wipe';

// Recording an audit at all. The online route (POST /assets/:id/audits) has
// always required one of these; the offline sync route did not check anything.
export const AUDIT_PERMISSIONS = ['perform_goods_in_audit', 'perform_amazon_audit'];

// Same rule as PermissionsGuard - admin is the master switch, otherwise any one
// of the listed grants - read from the same DB-fresh, cache-busted snapshot, so
// revoking a grant lands within seconds rather than at token expiry. A disabled
// or deleted account holds nothing.
export async function holds(
  permissions: PermissionsService,
  userId: string,
  anyOf: string[],
): Promise<boolean> {
  const authz = await permissions.getAuthz(userId);
  if (!authz || authz.disabled) return false;
  if (authz.role === UserRole.ADMIN) return true;
  return anyOf.some((p) => authz.permissions.includes(p));
}

export function mayRecordManualWipe(permissions: PermissionsService, userId: string): Promise<boolean> {
  return holds(permissions, userId, [RECORD_MANUAL_WIPE]);
}

// The one check every ONLINE route that can carry a wipe claim runs. Two fields
// carry it - the wipe record's own status, and the device's audit status - so
// both are checked, or the claim just moves to whichever route checked neither.
// (A review found exactly that: POST /assets and PATCH /assets/:id still let
// anyone set auditStatus 'data_wiped' after the audit route was closed.)
export function claimsWiped(fields: { dataWipeStatus?: unknown; auditStatus?: unknown }): boolean {
  return fields.dataWipeStatus === 'wiped' || fields.auditStatus === 'data_wiped';
}

// A ForbiddenException, so Nest answers 403 with this message - a plain Error
// would surface to the person as a 500.
export class ManualWipeForbidden extends ForbiddenException {
  constructor() {
    super(
      'Recording a drive as wiped by hand needs the "Record Manual Wipe" permission. ' +
        'Wipes done by the ALS audit station are recorded automatically.',
    );
  }
}

export async function assertMayClaimWiped(
  permissions: PermissionsService,
  userId: string | undefined,
  fields: { dataWipeStatus?: unknown; auditStatus?: unknown },
): Promise<void> {
  if (!claimsWiped(fields)) return;
  if (!userId || !(await mayRecordManualWipe(permissions, userId))) throw new ManualWipeForbidden();
}

// Who recorded this wipe. Rows written since wipe_source existed carry it. For
// anything older the migration's own rule applies: only the station ingest ever
// stores a hardware profile on an audit row, so a profile means the station.
export function sourceOf(wipe: Pick<AssetAudit, 'wipeSource' | 'hardwareProfile'>): WipeSource {
  if (wipe.wipeSource === 'station' || wipe.wipeSource === 'manual') return wipe.wipeSource;
  return wipe.hardwareProfile ? 'station' : 'manual';
}

export interface WipeAttestation {
  intro: string;
  result: string;
  performerLabel: string;
  dateLabel: string;
  methodSuffix: string;
}

// What a certificate may truthfully say, by who recorded the wipe. A pure
// function so the wording is tested without rendering a PDF.
export function wipeAttestation(source: WipeSource): WipeAttestation {
  if (source === 'manual') {
    return {
      intro:
        'This certifies that the data-storage media contained in the device identified below was recorded as sanitised, using the method stated, by the person named below. This erasure was entered manually: it was not performed or verified by the ALS audit station.',
      result: 'Wiped — manually recorded, not verified by the ALS audit station',
      performerLabel: 'Recorded by',
      // When it was typed in. The work itself happened somewhere else, at a
      // time this system never saw.
      dateLabel: 'Date recorded',
      methodSuffix: ' (manual record)',
    };
  }
  return {
    intro:
      'This certifies that the data-storage media contained in the device identified below has been sanitised using the method stated, rendering previously stored data unrecoverable by generally available means.',
    result: 'Wiped — data unrecoverable',
    performerLabel: 'Performed by',
    dateLabel: 'Date performed',
    methodSuffix: '',
  };
}

export interface LotAttestation {
  headline: string;
  intro: string;
  dateHeader: string;
}

// The lot certificate lists many devices, and a lot can mix station wipes with
// hand records. Three cases, because one sentence cannot be true of all of
// them: the headline, the lead sentence and the date column all used to say
// "erased" / "unrecoverable" / "Wiped" regardless of who recorded each row.
//
// limitedCount: station rows marked "(limitations recorded)" (plan step 39).
// Any limitation removes "unrecoverable" for that row, and the lead sentence
// is where a reader - or anyone quoting the certificate - takes the claim
// from, so it is scoped there, not only in a later paragraph. With none, the
// wording below is exactly what lots have always said.
export function lotAttestation(
  manualCount: number,
  total: number,
  limitedCount = 0,
): LotAttestation {
  if (limitedCount > 0)
    return limitedLotAttestation(manualCount, total, limitedCount);
  const station =
    'This certifies that the data-storage media in each device listed below has been sanitised using the method stated, rendering previously stored data unrecoverable by generally available means.';
  if (manualCount === 0) {
    return { headline: `Devices certified erased: ${total}`, intro: station, dateHeader: 'Wiped' };
  }
  if (manualCount === total) {
    return {
      headline: `Devices recorded as erased: ${total} (all entered manually)`,
      intro:
        'This certifies that the data-storage media in each device listed below was recorded as sanitised, using the method stated. Every record below was entered manually: none was performed or verified by the ALS audit station, and each is certified only as recorded. The date is the date it was recorded.',
      dateHeader: 'Recorded',
    };
  }
  return {
    headline: `Devices listed: ${total} (${total - manualCount} erased by the ALS audit station, ${manualCount} recorded manually)`,
    intro:
      'This certifies that the data-storage media in each device listed below, other than rows marked "(manual record)", has been sanitised using the method stated, rendering previously stored data unrecoverable by generally available means. Rows marked "(manual record)" were entered by hand: they were not performed or verified by the ALS audit station, are certified only as recorded, and are dated when they were recorded.',
    dateHeader: 'Date',
  };
}

function limitedLotAttestation(
  manualCount: number,
  total: number,
  limited: number,
): LotAttestation {
  const stationCount = total - manualCount;
  const unlimited = stationCount - limited;
  const excluded = [
    '"(limitations recorded)"',
    ...(manualCount ? ['"(manual record)"'] : []),
  ].join(' or ');
  const lead =
    unlimited > 0
      ? `This certifies that the data-storage media in each device listed below, other than rows marked ${excluded}, has been sanitised using the method stated, rendering previously stored data unrecoverable by generally available means.`
      : `This certifies that the data-storage media in each device listed below${
          manualCount ? ', other than rows marked "(manual record)",' : ''
        } has been sanitised using the method stated.`;
  const limitedSentence =
    'Rows marked "(limitations recorded)" were sanitised using the method stated, but limitations were recorded for their erasure: this certificate makes no claim that previously stored data on them cannot be recovered, and each such device\'s own certificate lists the limitations.';
  const manualSentence = manualCount
    ? ' Rows marked "(manual record)" were entered by hand: they were not performed or verified by the ALS audit station, are certified only as recorded, and are dated when they were recorded.'
    : '';
  return {
    headline: manualCount
      ? `Devices listed: ${total} (${stationCount} erased by the ALS audit station (${limited} with limitations recorded), ${manualCount} recorded manually)`
      : `Devices listed: ${total} (${limited} with limitations recorded)`,
    intro: `${lead} ${limitedSentence}${manualSentence}`,
    dateHeader: manualCount ? 'Date' : 'Wiped',
  };
}
