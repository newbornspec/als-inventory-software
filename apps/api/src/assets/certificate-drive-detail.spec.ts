import { FindOperator } from 'typeorm';
import type { AssetAudit } from './asset-audit.entity';
import { DataWipeStatus } from './asset-audit.entity';
import {
  buildDeviceCertificate,
  CLOCK_NOTE,
  LEGACY_DRIVE,
  MANUAL_DRIVE,
  NO_SERIAL,
  type DeviceCertificate,
} from './certificate-content';
import { CertificatesService, rollupFor } from './certificates.service';

// Plan step 20 (remediation spec D-5): the certificate names the drive(s) it
// certifies and the real wipe date. It used to list every drive of the host
// as sanitised and print the upload time as the date the wipe was performed.

const at = (iso: string) => new Date(iso);
const ASSET = {
  id: 'a1b2c3d4-0000-0000-0000-000000000000',
  tag: 'T-1',
  serialNumber: 'HOST-1',
  // The machine as captured LATER: a second drive fitted after the wipe.
  hardwareProfile: {
    identification: { manufacturer: 'Dell', model: 'Latitude 7490' },
    storage: [
      { capacity: '512GB', type: 'NVMe', serialNumber: 'S-A' },
      { capacity: '2000GB', type: 'HDD', serialNumber: 'LATER' },
    ],
  },
};
const SNAPSHOT = {
  identification: { manufacturer: 'Dell', model: 'Latitude 7490' },
  storage: [
    {
      capacity: '512GB',
      type: 'NVMe',
      interface: 'NVMe',
      serialNumber: 'S-A',
      model: 'Samsung SSD 980',
    },
  ],
};

const row = (over: Partial<AssetAudit> = {}): AssetAudit =>
  ({
    id: 'r1',
    assetId: ASSET.id,
    dataWipeStatus: DataWipeStatus.WIPED,
    dataWipeMethod: 'NVMe crypto erase — verified (reads as random)',
    wipeSource: 'station',
    hardwareProfile: SNAPSHOT,
    wipedAt: at('2026-09-12T10:01:07Z'),
    wipedAtClock: 'network',
    wipedDriveSerial: 'S-A',
    wipedDrive: {
      serialNumber: 'S-A',
      model: 'Samsung SSD 980',
      sizeBytes: 512110190592,
      transport: 'nvme',
      rotational: false,
      devicePath: '/dev/nvme0n1',
    },
    operatorName: 'J Smith',
    auditedBy: { name: 'Station' },
    // Reached the server three days later (queued offline on the stick).
    createdAt: at('2026-09-15T08:00:00Z'),
    ...over,
  }) as AssetAudit;

const certify = (rows: AssetAudit[]): DeviceCertificate =>
  buildDeviceCertificate(ASSET, rollupFor(rows), rows[rows.length - 1]);
const section = (c: DeviceCertificate, i = 0) =>
  Object.fromEntries(c.drives[i].rows);
const device = (c: DeviceCertificate) => Object.fromEntries(c.device);

describe('the certificate names the erased drive and the real date (step 20)', () => {
  it('prints the drive serial, model, capacity, interface and the wipe date', () => {
    const c = certify([row()]);
    expect(c.drives).toHaveLength(1);
    expect(c.drives[0].title).toBe('Storage medium erased');
    expect(section(c)).toMatchObject({
      Model: 'Samsung SSD 980',
      'Serial number': 'S-A',
      Capacity: '512GB',
      Interface: 'NVMe',
      'Date performed': '12 September 2026',
    });
    expect(section(c)).not.toHaveProperty('Date recorded');
    expect(section(c)).not.toHaveProperty('Clock');
  });

  it('notes a station clock that was not network-synchronised', () => {
    for (const clock of ['unsynced', null]) {
      const c = certify([row({ wipedAtClock: clock })]);
      expect(section(c).Clock).toBe(CLOCK_NOTE);
      expect(section(c)['Date performed']).toBe('12 September 2026');
    }
  });

  it('no wipedAt: "Date recorded" from receipt time', () => {
    const c = certify([row({ wipedAt: null })]);
    expect(section(c)['Date recorded']).toBe('15 September 2026');
    expect(section(c)).not.toHaveProperty('Date performed');
  });

  it('a drive that reports no serial says so (D18)', () => {
    const c = certify([
      row({
        wipedDriveSerial: null,
        wipedDrive: {
          model: 'Generic',
          devicePath: '/dev/sda',
          transport: 'sata',
          rotational: true,
        },
        hardwareProfile: { storage: [] },
      }),
    ]);
    expect(section(c)['Serial number']).toBe(NO_SERIAL);
    expect(section(c).Interface).toBe('SATA HDD');
  });

  it('falls back to the wipe-time profile for details an older stick did not send', () => {
    const c = certify([row({ wipedDrive: { serialNumber: 'S-A' } })]);
    expect(section(c)).toMatchObject({
      Model: 'Samsung SSD 980',
      Capacity: '512GB',
      Interface: 'NVMe',
    });
  });

  it('the host storage line comes from the wipe-time snapshot, not the current profile', () => {
    const c = certify([row()]);
    expect(device(c)['Storage fitted']).toBe('512GB NVMe');
    expect(JSON.stringify(c)).not.toContain('2000GB');
  });

  it('the intro and footer name the storage medium, not the whole device', () => {
    const c = certify([row()]);
    expect(c.intro).toContain('the storage medium identified below');
    expect(c.intro).not.toContain('contained in the device');
    expect(c.footer).toContain('storage medium identified above');
  });

  it('two drives: numbered sections, plural wording', () => {
    const b = row({
      id: 'r2',
      wipedDriveSerial: 'S-B',
      wipedDrive: { serialNumber: 'S-B', model: 'ST1000LM' },
      // Wiped a minute after A: its record carries the session's profile.
      wipedAt: at('2026-09-12T10:02:07Z'),
      hardwareProfile: {
        storage: [
          { serialNumber: 'S-A', capacity: '512GB', type: 'NVMe' },
          { serialNumber: 'S-B', capacity: '1000GB', type: 'HDD' },
        ],
      },
    });
    const c = certify([row(), b]);
    expect(c.drives.map((d) => d.title)).toEqual([
      'Storage medium erased (1 of 2)',
      'Storage medium erased (2 of 2)',
    ]);
    expect(c.intro).toContain('each storage medium identified below');
    expect(device(c)['Storage fitted']).toBe('512GB NVMe, 1000GB HDD');
  });

  it('keeps the certificate number derived from receipt time, as issued', () => {
    expect(certify([row()]).certNo).toBe('ERA-20260915-A1B2C3D4');
  });
});

describe('legacy and manual records (D20)', () => {
  const legacy = row({
    wipedAt: null,
    wipedAtClock: null,
    wipedDriveSerial: null,
    wipedDrive: null,
    // A pre-per-drive station record snapshotted the whole profile.
    hardwareProfile: ASSET.hardwareProfile,
  });

  it('a legacy record keeps its certificate, labelled, dated "Date recorded"', () => {
    const c = certify([legacy]);
    expect(section(c).Drive).toBe(LEGACY_DRIVE);
    expect(section(c)['Date recorded']).toBe('15 September 2026');
    expect(section(c)).not.toHaveProperty('Date performed');
    expect(section(c)).not.toHaveProperty('Serial number');
  });

  it('does not list every host drive as sanitised', () => {
    const c = certify([legacy]);
    // One "storage medium" section, labelled as not individually recorded;
    // the host's drives appear only as what was fitted.
    expect(c.drives).toHaveLength(1);
    expect(Object.fromEntries(c.erasure)['Storage media erased']).toBe('1');
    expect(c.drives.flatMap((d) => d.rows.map(([, v]) => v))).not.toContain(
      'LATER',
    );
  });

  it('a manual record keeps the manual wording and says the drive was not recorded', () => {
    const manual = row({
      wipeSource: 'manual',
      hardwareProfile: null,
      wipedAt: null,
      wipedDriveSerial: null,
      wipedDrive: null,
      dataWipeMethod: 'Physical destruction',
    });
    const c = certify([manual]);
    expect(c.intro).toContain('entered manually');
    expect(section(c).Drive).toBe(MANUAL_DRIVE);
    expect(section(c).Method).toBe('Physical destruction (manual record)');
    expect(section(c)['Date recorded']).toBe('15 September 2026');
  });
});

describe('lot certificate: a drive-serial column', () => {
  it('lists each certified device with its drive serial(s)', async () => {
    const a1 = {
      ...ASSET,
      id: 'a1',
      tag: 'T-a1',
      serialNumber: 'SN-a1',
      batchId: 'b1',
    };
    const a2 = {
      ...ASSET,
      id: 'a2',
      tag: 'T-a2',
      serialNumber: 'SN-a2',
      batchId: 'b1',
    };
    const rows = [
      row({ assetId: 'a1' }),
      row({
        id: 'r9',
        assetId: 'a2',
        wipedDriveSerial: null,
        wipedDrive: null,
        wipedAt: null,
      }),
    ];
    const qb = {
      addSelect: () => qb,
      where: () => qb,
      getMany: () => Promise.resolve([a1, a2]),
    };
    const svc = new CertificatesService(
      { createQueryBuilder: () => qb } as never,
      {
        find: ({ where }: { where: { assetId: FindOperator<string[]> } }) =>
          Promise.resolve(
            rows.filter((r) => where.assetId.value.includes(r.assetId)),
          ),
      } as never,
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
    const listed = (renderLot.mock.calls[0] as unknown[])[1] as Array<{
      serial: string;
      drives: string;
      storage: string;
    }>;
    expect(listed.map((r) => [r.serial, r.drives])).toEqual([
      ['SN-a1', 'S-A'],
      ['SN-a2', 'Not individually recorded'],
    ]);
    expect(listed[0].storage).toBe('512GB NVMe');
  });

  it('renders a real lot PDF with the new column', async () => {
    const rows = [row({ assetId: 'a1' })];
    const qb = {
      addSelect: () => qb,
      where: () => qb,
      getMany: () => Promise.resolve([{ ...ASSET, id: 'a1', batchId: 'b1' }]),
    };
    const svc = new CertificatesService(
      { createQueryBuilder: () => qb } as never,
      { find: () => Promise.resolve(rows) } as never,
      {
        findOne: () =>
          Promise.resolve({ id: 'b1', batchNumber: 'LOT-1', ownerId: null }),
      } as never,
    );
    const { buffer } = await svc.lotErasureCertificate('b1');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders a real device PDF for a two-drive machine', async () => {
    const rows = [
      row(),
      row({
        id: 'r2',
        wipedDriveSerial: 'S-B',
        wipedDrive: { serialNumber: 'S-B' },
        hardwareProfile: { storage: [] },
      }),
    ];
    const qb = {
      addSelect: () => qb,
      where: () => qb,
      getOne: () => Promise.resolve({ ...ASSET, batchId: 'b1' }),
    };
    const svc = new CertificatesService(
      { createQueryBuilder: () => qb } as never,
      { find: () => Promise.resolve(rows) } as never,
      {} as never,
    );
    const { buffer } = await svc.erasureCertificate(ASSET.id);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
