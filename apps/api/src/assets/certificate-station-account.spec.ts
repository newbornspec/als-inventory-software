import type { AssetAudit } from './asset-audit.entity';
import { DataWipeStatus } from './asset-audit.entity';
import {
  buildDeviceCertificate,
  TOOL_NOT_RECORDED,
  type DeviceCertificate,
} from './certificate-content';
import { OPERATOR_NOT_RECORDED, erasurePeople } from './certificate-people';
import { rollupFor } from './certificates.service';
import { wipeAttestation } from './manual-wipe';

// Plan step 28, stage 1 (owner decision D28): a wipe filed by a SHARED station
// account with no typed operator, or by a stick that does not say which tool
// version it ran, still gets its certificate - stage 1 never blocks - but the
// certificate says plainly what was not recorded.

const ASSET = {
  id: 'a1b2c3d4-0000-0000-0000-000000000000',
  tag: 'T-1',
  serialNumber: 'HOST-1',
  hardwareProfile: null,
};

const row = (over: Partial<AssetAudit> = {}): AssetAudit =>
  ({
    id: 'r1',
    assetId: ASSET.id,
    dataWipeStatus: DataWipeStatus.WIPED,
    dataWipeMethod: 'NVMe crypto erase — verified (reads as random)',
    wipeSource: 'station',
    hardwareProfile: {
      storage: [{ serialNumber: 'S-A', capacity: '512GB', type: 'NVMe' }],
    },
    wipedAt: new Date('2026-09-12T10:01:07Z'),
    wipedAtClock: 'network',
    wipedDriveSerial: 'S-A',
    wipedDrive: { serialNumber: 'S-A', model: 'Samsung SSD 980' },
    toolName: 'als-audit-station',
    toolVersion: '2026.09.19',
    toolCommit: '7eda9ea',
    operatorName: null,
    auditedBy: { name: 'Station', isStation: true },
    createdAt: new Date('2026-09-12T10:02:00Z'),
    ...over,
  }) as AssetAudit;

const certify = (r: AssetAudit): DeviceCertificate =>
  buildDeviceCertificate(ASSET, rollupFor([r]), r);
const section = (c: DeviceCertificate) => Object.fromEntries(c.drives[0].rows);

describe('certificates from a shared station account (step 28, stage 1)', () => {
  it('a station-flagged account with no operator: "Operator: not recorded (shared station account)"', () => {
    const c = certify(row());
    expect(section(c).Operator).toBe(OPERATOR_NOT_RECORDED);
    expect(OPERATOR_NOT_RECORDED).toBe('not recorded (shared station account)');
    // Still names the account as the account, never as the performer.
    expect(section(c)['Filed by account']).toBe('Station');
    expect(c.drives[0].rows.flat()).not.toContain('Performed by');
  });

  it('is issued anyway - stage 1 labels, it never refuses', () => {
    const c = certify(row({ toolVersion: null }));
    expect(c.certNo).toMatch(/^ERA-/);
    expect(c.drives).toHaveLength(1);
  });

  it('a typed operator name on a station account prints as self-declared, no "not recorded"', () => {
    const c = certify(row({ operatorName: 'J Smith' }));
    expect(section(c)['Operator (self-declared)']).toBe('J Smith');
    expect(section(c)).not.toHaveProperty('Operator');
  });

  it('an account NOT flagged as a station prints as before (no Operator line)', () => {
    for (const auditedBy of [
      { name: 'Ada Admin', isStation: false },
      { name: 'Ada Admin' }, // an entity loaded before the column existed
    ]) {
      const c = certify(row({ auditedBy } as Partial<AssetAudit>));
      expect(section(c)).not.toHaveProperty('Operator');
      expect(section(c)['Filed by account']).toBe('Ada Admin');
    }
  });

  it('a manual record never gets the station line, even from a flagged account', () => {
    expect(
      erasurePeople('manual', wipeAttestation('manual'), null, 'Station', true),
    ).toEqual([['Recorded by', 'Station']]);
  });

  it('no toolVersion: "Tool version: not recorded"', () => {
    for (const toolVersion of [null, '', '  ']) {
      const c = certify(row({ toolVersion, toolName: null, toolCommit: null }));
      expect(section(c)['Tool version']).toBe(TOOL_NOT_RECORDED);
      expect(TOOL_NOT_RECORDED).toBe('not recorded');
    }
  });

  it('a recorded tool prints its name, version and build', () => {
    expect(section(certify(row()))['Tool version']).toBe(
      'als-audit-station 2026.09.19 (build 7eda9ea)',
    );
    expect(
      section(certify(row({ toolName: null, toolCommit: null })))[
        'Tool version'
      ],
    ).toBe('2026.09.19');
  });

  it('prints names only - no job title or contact line', () => {
    const labels = certify(row({ operatorName: 'J Smith' })).drives[0].rows.map(
      ([k]) => k,
    );
    for (const l of labels) expect(l).not.toMatch(/title|contact|email|phone/i);
  });
});
