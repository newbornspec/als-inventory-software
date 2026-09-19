import PDFDocument from 'pdfkit';
import type { AssetAudit } from './asset-audit.entity';
import { DataWipeStatus } from './asset-audit.entity';
import {
  buildDeviceCertificate,
  limitationsNotice,
  LOCK_NOTICE,
  NOT_ASSESSED,
  QUALIFIED_RESULT,
  UNQUALIFIED_DRIVE_RESULT,
  type DeviceCertificate,
} from './certificate-content';
import { CertificatesService, rollupFor } from './certificates.service';
import { ingestHarness } from '../devices/ingest-harness-for-spec';
import type { IngestAuditDto } from '../devices/dto/ingest-audit.dto';

// Plan step 39 (remediation spec D-4, D-2): the certificate prints what wave 1
// now stores - level, method requested vs achieved and why, verification,
// hidden areas, limitations, lock status - and stops saying "unrecoverable"
// when any limitation was recorded.

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
    hardwareProfile: { storage: [{ serialNumber: 'S-A' }] },
    wipedAt: new Date('2026-09-19T10:01:07Z'),
    wipedAtClock: 'network',
    wipedDriveSerial: 'S-A',
    wipedDrive: { serialNumber: 'S-A', model: 'Samsung SSD 980' },
    toolVersion: '2026.09.19',
    wipeMethodRequested: 'auto',
    wipeMethodAttempted: 'nvme-sanitize-crypto',
    wipeFallbackReason: null,
    sanitisationLevel: 'purge',
    wipeVerification: 'clean',
    hiddenAreas: 'none',
    wipeLimitations: [],
    lockStatus: 'CLEAR',
    createdAt: new Date('2026-09-19T10:02:00Z'),
    ...over,
  }) as AssetAudit;

const certify = (...rows: AssetAudit[]): DeviceCertificate =>
  buildDeviceCertificate(ASSET, rollupFor(rows), rows[rows.length - 1]);
const drive = (c: DeviceCertificate, i = 0) =>
  Object.fromEntries(c.drives[i].rows);
const everything = (c: DeviceCertificate) => JSON.stringify(c);

describe('what the erasure achieved (step 39)', () => {
  it('a clean purge prints its level and keeps "unrecoverable"', () => {
    const c = certify(row());
    expect(drive(c)).toMatchObject({
      'Sanitisation level': 'Purge (NIST SP 800-88)',
      'Method requested': 'Automatic (the strongest the drive supports)',
      'Fallback reason': 'None',
      Verification: 'Read back — no residual data found',
      'Hidden areas (HPA/DCO)': 'None present',
      Limitations: 'None reported',
      Result: 'Wiped — data unrecoverable',
    });
    expect(c.intro).toContain('unrecoverable');
  });

  it('any limitation removes "unrecoverable" everywhere and prints the limitation', () => {
    const limitation =
      'Reallocated sectors present (12): remapped blocks may keep old data';
    const c = certify(
      row({ sanitisationLevel: 'clear', wipeLimitations: [limitation] }),
    );
    expect(everything(c)).not.toMatch(/unrecoverable/i);
    expect(drive(c).Limitations).toBe(limitation);
    expect(drive(c).Result).toBe(QUALIFIED_RESULT);
    expect(Object.fromEntries(c.erasure).Result).toBe(QUALIFIED_RESULT);
    expect(c.intro).toContain('Limitations were recorded');
  });

  it('a limitation on ONE of two drives qualifies the whole certificate', () => {
    const b = row({
      id: 'r2',
      wipedDriveSerial: 'S-B',
      wipedDrive: { serialNumber: 'S-B' },
      wipeLimitations: ['Hidden areas could not be checked'],
      hardwareProfile: {
        storage: [{ serialNumber: 'S-A' }, { serialNumber: 'S-B' }],
      },
      wipedAt: new Date('2026-09-19T10:03:00Z'),
    });
    const c = certify(row(), b);
    expect(c.drives).toHaveLength(2);
    expect(c.intro).not.toMatch(/unrecoverable/i);
    // Drive A itself had none, and says so - without "unrecoverable".
    expect(drive(c, 0).Result).toBe(UNQUALIFIED_DRIVE_RESULT);
    expect(JSON.stringify(c)).not.toMatch(/unrecoverable/i);
    expect(drive(c, 1).Result).toBe(QUALIFIED_RESULT);
  });

  it('prints the fallback reason and the requested method', () => {
    const c = certify(
      row({
        wipeMethodRequested: 'secure',
        wipeFallbackReason: 'frozen',
        dataWipeMethod: 'Overwrite — single zero pass (NIST Clear)',
      }),
    );
    expect(drive(c)).toMatchObject({
      'Method requested': 'Firmware secure erase',
      Method: 'Overwrite — single zero pass (NIST Clear)',
      'Fallback reason': 'The drive was security-frozen by the firmware',
    });
  });

  it('a value the certificate has no wording for is printed as stored', () => {
    expect(
      drive(certify(row({ wipeFallbackReason: 'bridge_timeout' })))[
        'Fallback reason'
      ],
    ).toBe('bridge_timeout');
  });

  it('a LOCKED device is still certified, with a lock line and note (D39)', () => {
    const c = certify(row({ lockStatus: 'LOCKED' }));
    expect(Object.fromEntries(c.device)['Device lock']).toBe(
      'LOCKED — see the note below',
    );
    expect(c.notices).toEqual([LOCK_NOTICE]);
  });

  it('every field null prints "Not assessed" (an older stick)', () => {
    const c = certify(
      row({
        toolVersion: null,
        wipeMethodRequested: null,
        wipeMethodAttempted: null,
        wipeFallbackReason: null,
        sanitisationLevel: null,
        wipeVerification: null,
        hiddenAreas: null,
        wipeLimitations: null,
        lockStatus: null,
      }),
    );
    expect(drive(c)).toMatchObject({
      'Sanitisation level': NOT_ASSESSED,
      'Method requested': NOT_ASSESSED,
      'Fallback reason': NOT_ASSESSED,
      Verification: NOT_ASSESSED,
      'Hidden areas (HPA/DCO)': NOT_ASSESSED,
      Limitations: NOT_ASSESSED,
    });
    expect(Object.fromEntries(c.device)['Device lock']).toBe(NOT_ASSESSED);
    expect(c.notices).toEqual([]);
  });

  it('a manual record does not pretend the station assessed anything', () => {
    const c = certify(
      row({
        wipeSource: 'manual',
        hardwareProfile: null,
        wipedDriveSerial: null,
        wipedDrive: null,
        wipedAt: null,
        wipeLimitations: null,
      }),
    );
    expect(drive(c)).not.toHaveProperty('Sanitisation level');
    expect(c.intro).toContain('entered manually');
  });
});

describe('an old payload with none of the new fields', () => {
  it('still files, and still gets a certificate (rendered for real)', async () => {
    const { svc: devices, audits } = ingestHarness();
    const old = {
      profile: {
        identification: {
          manufacturer: 'Dell',
          model: 'Latitude 7490',
          serialNumber: 'OLD-1',
        },
      },
      auditKind: 'amazon',
      dataWipeStatus: DataWipeStatus.WIPED,
      dataWipeMethod: 'NVMe crypto erase',
    } as IngestAuditDto;
    await expect(devices.ingest('u1', old)).resolves.toMatchObject({
      tag: 'OLD-1',
    });
    const stored = audits[0] as unknown as AssetAudit;
    expect(stored.sanitisationLevel).toBeNull();

    const texts: string[] = [];
    type Text = (...a: unknown[]) => unknown;
    const proto = (PDFDocument as unknown as { prototype: { text: Text } })
      .prototype;
    const real = proto.text;
    const spy = jest.spyOn(proto, 'text').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      if (typeof args[0] === 'string') texts.push(args[0]);
      return real.apply(this, args);
    });
    const qb = {
      addSelect: () => qb,
      where: () => qb,
      getOne: () => Promise.resolve({ ...ASSET, batchId: null }),
    };
    const certs = new CertificatesService(
      { createQueryBuilder: () => qb } as never,
      { find: () => Promise.resolve([stored]) } as never,
      {} as never,
    );
    try {
      const { buffer } = await certs.erasureCertificate(ASSET.id);
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    } finally {
      spy.mockRestore();
    }
    expect(texts).toContain('Sanitisation level');
    expect(texts[texts.indexOf('Sanitisation level') + 1]).toBe(NOT_ASSESSED);
  });
});

describe('lot certificate and limitations', () => {
  it('marks a device with limitations and says what that means', async () => {
    const a1 = { ...ASSET, id: 'a1', serialNumber: 'SN-a1', batchId: 'b1' };
    const a2 = { ...ASSET, id: 'a2', serialNumber: 'SN-a2', batchId: 'b1' };
    const rows = [
      row({ assetId: 'a1' }),
      row({
        id: 'r2',
        assetId: 'a2',
        wipeLimitations: ['Hidden areas unknown'],
      }),
    ];
    const qb = {
      addSelect: () => qb,
      where: () => qb,
      getMany: () => Promise.resolve([a1, a2]),
    };
    const svc = new CertificatesService(
      { createQueryBuilder: () => qb } as never,
      { find: () => Promise.resolve(rows) } as never,
      {
        findOne: () =>
          Promise.resolve({ id: 'b1', batchNumber: 'LOT-1', ownerId: null }),
      } as never,
    );
    const renderLot = jest
      .spyOn(
        svc as unknown as { renderLot: () => Promise<Buffer> },
        'renderLot',
      )
      .mockResolvedValue(Buffer.from('pdf'));
    await svc.lotErasureCertificate('b1');
    const args = renderLot.mock.calls[0] as unknown[];
    const listed = args[1] as Array<{ serial: string; method: string }>;
    expect(
      listed.map((r) => r.method.endsWith('(limitations recorded)')),
    ).toEqual([false, true]);
    expect(args[5]).toBe(1);
    expect(limitationsNotice(1)).toContain('not covered by the statement');
  });
});
