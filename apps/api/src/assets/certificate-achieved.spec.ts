import PDFDocument from 'pdfkit';
import type { AssetAudit } from './asset-audit.entity';
import { DataWipeStatus } from './asset-audit.entity';
import {
  buildDeviceCertificate,
  LOCK_NOTICE,
  NOT_ASSESSED,
  QUALIFIED_RESULT,
  UNQUALIFIED_DRIVE_RESULT,
  type DeviceCertificate,
} from './certificate-content';
import {
  CertificatesService,
  LOT_NOT_SIGNED_NOTICE,
  rollupFor,
} from './certificates.service';
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

  // Review, wave 2: a hidden area that may still hold data is a reason to
  // doubt "unrecoverable" even when the engine listed no limitation for it
  // (an older engine, or one that does not add the D34 limitation).
  it('a hidden area present or unchecked removes "unrecoverable"', () => {
    for (const hiddenAreas of ['hpa-present', 'dco-present', 'unknown']) {
      const c = certify(row({ hiddenAreas, wipeLimitations: [] }));
      expect(everything(c)).not.toMatch(/unrecoverable/i);
      expect(drive(c).Result).toBe(QUALIFIED_RESULT);
    }
    for (const hiddenAreas of ['none', 'hpa-removed', null])
      expect(certify(row({ hiddenAreas })).intro).toContain('unrecoverable');
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
  type Listed = {
    serial: string;
    device: string;
    method: string;
    date: string;
  };
  type Lot = { headline: string; intro: string; dateHeader: string };

  // The lot route with the renderer stubbed: returns what it was handed.
  async function lotOf(
    assets: Array<Record<string, unknown>>,
    rows: AssetAudit[],
    ledger?: { enabled: boolean },
  ): Promise<{ listed: Listed[]; lot: Lot; notices: string[] }> {
    const qb = {
      addSelect: () => qb,
      where: () => qb,
      getMany: () => Promise.resolve(assets),
    };
    const svc = new CertificatesService(
      { createQueryBuilder: () => qb } as never,
      { find: () => Promise.resolve(rows) } as never,
      {
        findOne: () =>
          Promise.resolve({ id: 'b1', batchNumber: 'LOT-1', ownerId: null }),
      } as never,
      ledger as never,
    );
    const renderLot = jest
      .spyOn(
        svc as unknown as { renderLot: () => Promise<Buffer> },
        'renderLot',
      )
      .mockResolvedValue(Buffer.from('pdf'));
    await svc.lotErasureCertificate('b1');
    const args = renderLot.mock.calls[0] as unknown[];
    return {
      listed: args[1] as Listed[],
      lot: args[2] as Lot,
      notices: args[3] as string[],
    };
  }
  const a1 = { ...ASSET, id: 'a1', serialNumber: 'SN-a1', batchId: 'b1' };
  const a2 = { ...ASSET, id: 'a2', serialNumber: 'SN-a2', batchId: 'b1' };

  // Cross-check, wave 2 (D29 "unsigned, marked"): with CERT_SIGNING_KEY set,
  // each device's certificate is signed and says so, but the lot summary is
  // never signed - and said nothing, so its holder could not tell it apart
  // from a signed document. Without the key nothing changes (no signature
  // wording anywhere, as before).
  it('with signing on, the (unsigned) lot summary says it is not signed', async () => {
    const signedOn = await lotOf([a1], [row({ assetId: 'a1' })], {
      enabled: true,
    });
    expect(signedOn.notices).toContain(LOT_NOT_SIGNED_NOTICE);
    for (const ledger of [undefined, { enabled: false }]) {
      const { notices } = await lotOf([a1], [row({ assetId: 'a1' })], ledger);
      expect(notices.join(' ')).not.toMatch(/sign/i);
    }
  });

  it('marks a device with limitations, and the lead sentence excludes it', async () => {
    const { listed, lot } = await lotOf(
      [a1, a2],
      [
        row({ assetId: 'a1' }),
        row({
          id: 'r2',
          assetId: 'a2',
          wipeLimitations: ['Hidden areas unknown'],
        }),
      ],
    );
    expect(
      listed.map((r) => r.method.endsWith('(limitations recorded)')),
    ).toEqual([false, true]);
    // The sentence the renderer draws first scopes "unrecoverable".
    expect(lot.intro).toMatch(
      /^[^.]*other than rows marked "\(limitations recorded\)"[^.]*unrecoverable/,
    );
    expect(lot.headline).toMatch(/1 with limitations recorded/);
  });

  it('every listed device limited: the lead sentence never says unrecoverable', async () => {
    const { lot } = await lotOf(
      [a1],
      [row({ assetId: 'a1', wipeLimitations: ['Hidden areas unknown'] })],
    );
    expect(`${lot.headline} ${lot.intro}`).not.toMatch(/unrecoverable/i);
  });

  it('a LOCKED device is listed with a lock mark and a lock note (D39)', async () => {
    const { listed, notices } = await lotOf(
      [a1, a2],
      [
        row({ assetId: 'a1', lockStatus: 'LOCKED' }),
        row({ id: 'r2', assetId: 'a2' }),
      ],
    );
    expect(listed[0].device).toContain('(device LOCKED)');
    expect(listed[1].device).not.toContain('LOCKED');
    expect(notices.join(' ')).toMatch(
      /1 listed device marked "\(device LOCKED\)"/,
    );
  });

  it("dates a station row by the station's wipe time, not its arrival", async () => {
    // Wiped 1 Sep, sat in the stick's offline queue until 4 Sep.
    const { listed } = await lotOf(
      [a1, a2],
      [
        row({
          assetId: 'a1',
          wipedAt: new Date('2026-09-01T10:00:00Z'),
          createdAt: new Date('2026-09-04T09:00:00Z'),
        }),
        // A legacy record: no station time, so it is dated when recorded,
        // and says so.
        row({
          id: 'r2',
          assetId: 'a2',
          wipedAt: null,
          wipedDriveSerial: null,
          wipedDrive: null,
          createdAt: new Date('2026-09-04T09:00:00Z'),
        }),
      ],
    );
    expect(listed[0].date).toBe(
      new Date('2026-09-01T10:00:00Z').toLocaleDateString('en-GB'),
    );
    expect(listed[1].date).toBe(
      `${new Date('2026-09-04T09:00:00Z').toLocaleDateString('en-GB')} (recorded)`,
    );
  });
});
