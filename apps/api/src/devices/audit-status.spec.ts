import { deriveAuditStatus, derivedMayReplace } from './devices.service';
import { AssetAuditStatus } from '../assets/asset.entity';
import { DataWipeStatus } from '../assets/asset-audit.entity';
import type { IngestAuditDto } from './dto/ingest-audit.dto';
import type { HardwareProfile } from './hardware-profile.type';

// This is what stops assets.audit_status going stale again. Everything that reads
// audit state off the asset rather than the trail — the dashboard's "Never audited"
// row, ReportsService's awaitingAudit, the noAudit filter, the per-lot audited
// counts — depends on ingest() deriving something here for the capture tool, which
// sends no explicit call of its own.

const PROFILE = { identification: { manufacturer: 'Dell', model: 'Latitude 7490' } } as HardwareProfile;
const dto = (over: Partial<IngestAuditDto> = {}): IngestAuditDto => ({ ...over }) as IngestAuditDto;

describe('deriveAuditStatus', () => {
  it('treats a returned hardware profile as proof the unit powers on', () => {
    expect(deriveAuditStatus(dto({ profile: PROFILE }))).toBe(AssetAuditStatus.POWER_ON);
  });

  it('records a wipe result ahead of the power-on floor', () => {
    expect(
      deriveAuditStatus(dto({ profile: PROFILE, dataWipeStatus: DataWipeStatus.WIPED })),
    ).toBe(AssetAuditStatus.DATA_WIPED);
    expect(
      deriveAuditStatus(dto({ profile: PROFILE, dataWipeStatus: DataWipeStatus.FAILED })),
    ).toBe(AssetAuditStatus.DATA_WIPE_FAILED);
  });

  it('does not treat "wipe not started" as an outcome', () => {
    expect(
      deriveAuditStatus(dto({ profile: PROFILE, dataWipeStatus: DataWipeStatus.NOT_STARTED })),
    ).toBe(AssetAuditStatus.POWER_ON);
  });

  it('claims nothing for a hand-entered device', () => {
    // The "Add asset" form builds a profile out of what was typed and posts to the
    // same endpoint, so this is the check that keeps a typed label from reading as
    // a machine that booted.
    expect(deriveAuditStatus(dto({ profile: PROFILE, manual: true }))).toBeNull();
  });

  it('claims nothing when there is no capture at all', () => {
    expect(deriveAuditStatus(dto())).toBeNull();
  });

  it('never infers that a unit passed testing', () => {
    const everything = dto({
      profile: PROFILE,
      dataWipeStatus: DataWipeStatus.WIPED,
      cosmeticGrade: undefined,
      biosLocked: false,
      chargerIncluded: true,
    });
    expect(deriveAuditStatus(everything)).not.toBe(AssetAuditStatus.PASSED_TESTING);
    expect(deriveAuditStatus(everything)).not.toBe(AssetAuditStatus.READY_FOR_SALE);
  });
});

// The write-back guard. deriveAuditStatus decides what a capture proves; this decides
// whether that inference is allowed to displace what the asset already carries. It is
// the half where getting it wrong is silent — a lost wipe result, or a technician's
// verdict quietly overwritten by a machine.
describe('derivedMayReplace', () => {
  const HUMAN_CALLS = [
    AssetAuditStatus.READY_FOR_SALE,
    AssetAuditStatus.PASSED_TESTING,
    AssetAuditStatus.FAILED_TESTING,
    AssetAuditStatus.REFURBISHED,
    AssetAuditStatus.REPAIR_REQUIRED,
    AssetAuditStatus.BEYOND_ECONOMIC_REPAIR,
  ];

  it('fills a blank with anything derived', () => {
    for (const s of [
      AssetAuditStatus.POWER_ON,
      AssetAuditStatus.DATA_WIPED,
      AssetAuditStatus.DATA_WIPE_FAILED,
    ]) {
      expect(derivedMayReplace(s, null)).toBe(true);
    }
  });

  it('never overwrites a human verdict', () => {
    for (const human of HUMAN_CALLS) {
      expect(derivedMayReplace(AssetAuditStatus.POWER_ON, human)).toBe(false);
      expect(derivedMayReplace(AssetAuditStatus.DATA_WIPED, human)).toBe(false);
      expect(derivedMayReplace(AssetAuditStatus.DATA_WIPE_FAILED, human)).toBe(false);
    }
  });

  it('lets a wipe result land on a unit only known to power on', () => {
    // The case the backfill created: ~16-35 assets stamped 'power_on', whose first
    // wipe after deploy would otherwise never reach the asset.
    expect(derivedMayReplace(AssetAuditStatus.DATA_WIPED, AssetAuditStatus.POWER_ON)).toBe(true);
    expect(derivedMayReplace(AssetAuditStatus.DATA_WIPE_FAILED, AssetAuditStatus.POWER_ON)).toBe(true);
  });

  it('never lets a plain re-capture erase a wipe result', () => {
    expect(derivedMayReplace(AssetAuditStatus.POWER_ON, AssetAuditStatus.DATA_WIPED)).toBe(false);
    expect(derivedMayReplace(AssetAuditStatus.POWER_ON, AssetAuditStatus.DATA_WIPE_FAILED)).toBe(false);
  });

  it('records a re-wipe that finally succeeds, and a later failure', () => {
    // A strict > between the two wipe ranks would strand a unit on 'data_wipe_failed'
    // forever, which is the more compliance-relevant direction of the two.
    expect(derivedMayReplace(AssetAuditStatus.DATA_WIPED, AssetAuditStatus.DATA_WIPE_FAILED)).toBe(true);
    expect(derivedMayReplace(AssetAuditStatus.DATA_WIPE_FAILED, AssetAuditStatus.DATA_WIPED)).toBe(true);
  });

  it('does not rewrite an unchanged value', () => {
    // assets is in the powersync publication, so a no-op UPDATE still costs a WAL
    // record and a sync to every offline client.
    for (const s of [
      AssetAuditStatus.POWER_ON,
      AssetAuditStatus.DATA_WIPED,
      AssetAuditStatus.DATA_WIPE_FAILED,
    ]) {
      expect(derivedMayReplace(s, s)).toBe(false);
    }
  });
});
