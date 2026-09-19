import { AssetAuditStatus } from './asset.entity';
import { DataWipeStatus } from './asset-audit.entity';

// A recorded wipe METHOD that is not an erase, whatever status came with it.
//
// Until 771bc40 the station fell through to `blkdiscard` (TRIM) on an SSD whose
// firmware erase had failed, recorded "Block discard / TRIM (SSD)" as the method
// and "wiped" as the status - and its read-back passed, because a TRIMmed drive
// reads zeros by design (the DRAT/RZAT capability bits) while the NAND behind
// it can be untouched. TRIM is a hint to the controller, not an erase: NIST SP
// 800-88r2 and IEEE 2883 recognise it as neither Clear nor Purge (remediation
// spec D-1). Those certificates were confidently wrong.
//
// The station no longer does it, but two things outlive that fix: rows already
// in the database, and any stick still running the old script. This is the one
// rule every door applies - the certificate routes, station ingest, and the web
// audit form.

// The text-mode wipe joined several drives into one string with "; ", so each
// drive's segment is judged on its own: one TRIMmed drive leaves the machine
// unsanitised. A segment that ALSO names a real erase ("TRIM, then overwrite")
// is not refused - the spec allows discard as a pre-step to an overwrite, just
// never as the method on its own.
const DISCARD = /block discard|blkdiscard|\btrim\b/i;
const REAL_ERASE = /overwrite|erase|sanitiz|sanitis|shred|zero pass|destr/i;

export function isNotAnErase(method: string | null | undefined): boolean {
  if (!method) return false;
  return method
    .split(';')
    .some((segment) => DISCARD.test(segment) && !REAL_ERASE.test(segment));
}

export const DISCARD_REFUSAL =
  'The wipe recorded for this device was a block discard (TRIM), which is not an erase: the drive can ' +
  'read back as zeros while the data is still on it. No erasure certificate can be issued for it. ' +
  'Wipe the drive again with the ALS audit station, then issue the certificate.';

// The lot certificate's line for devices it left off. Without it a lot of 40
// that certifies 37 reads exactly like a lot of 37.
export function discardedNotice(n: number): string {
  return `${n} further device${n === 1 ? '' : 's'} in this lot ${n === 1 ? 'is' : 'are'} not listed: the wipe recorded for ${
    n === 1 ? 'it' : 'each'
  } was a block discard (TRIM), which is not an erase. ${n === 1 ? 'It is' : 'They are'} not certified by this document.`;
}

// What an old stick's TRIM "wipe" becomes on the way in: a record of what the
// tool did, with the status it actually earned.
export const DISCARD_NOTE =
  '[Recorded as FAILED, not wiped: the station reported a block discard (TRIM), which is not an erase. ' +
  'This stick is running wipe software from before 19 Sep 2026 - update it and wipe the drive again.]';

interface WipeClaim {
  dataWipeStatus?: string | null;
  dataWipeMethod?: string | null;
  auditStatus?: string | null;
  notes?: string | null;
}

// Station ingest: never let a discard land as "wiped". The record is kept -
// the hardware profile, the grade and the method all still matter - but its
// status is FAILED and the note says why, so the device is not shown as erased
// and cannot be certified.
export function downgradeDiscardClaim<T extends WipeClaim>(dto: T): T {
  if (
    dto.dataWipeStatus !== DataWipeStatus.WIPED ||
    !isNotAnErase(dto.dataWipeMethod)
  )
    return dto;
  return {
    ...dto,
    dataWipeStatus: DataWipeStatus.FAILED,
    auditStatus:
      dto.auditStatus === AssetAuditStatus.DATA_WIPED
        ? AssetAuditStatus.DATA_WIPE_FAILED
        : dto.auditStatus,
    notes: dto.notes ? `${dto.notes}\n${DISCARD_NOTE}` : DISCARD_NOTE,
  };
}
