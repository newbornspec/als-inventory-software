import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { CertificatesService } from './certificates.service';
import { DataWipeStatus } from './asset-audit.entity';
import type { DeviceCertificate } from './certificate-content';
import { UserRole } from '../users/user.entity';
// The web page's helper, imported by path as certificate-eligibility.spec.ts
// does: it is pure and dependency-free.
import * as web from '../../../web/lib/certificate-eligibility';

// Plan step 23 (remediation spec D-6, owner decision D23): the certificate is
// issued only when EVERY drive of the machine is erased, and it is one
// certificate per machine listing each drive.

const MIN = 60 * 1000;
const T0 = new Date('2026-09-19T10:00:00Z').getTime();
const at = (m: number) => new Date(T0 + m * MIN);

const PROFILE = {
  identification: { manufacturer: 'Dell', model: 'Latitude 7490' },
  storage: [
    {
      model: 'Samsung SSD 980',
      serialNumber: 'S-A',
      interface: 'NVMe',
      type: 'NVMe',
      capacity: '512GB',
    },
    {
      model: 'ST1000LM',
      serialNumber: 'S-B',
      interface: 'SATA',
      type: 'HDD',
      capacity: '1000GB',
    },
  ],
};

let seq = 0;
const drive = (
  serial: string,
  status: DataWipeStatus,
  m: number,
  extra: Record<string, unknown> = {},
) => ({
  id: `r${++seq}`,
  assetId: 'a1',
  dataWipeStatus: status,
  dataWipeMethod: 'NVMe crypto erase — verified (reads as random)',
  wipeSource: 'station',
  hardwareProfile: PROFILE,
  wipedAt: at(m),
  wipedAtClock: 'network',
  wipedDriveSerial: serial,
  wipedDrive: {
    serialNumber: serial,
    model: serial === 'S-A' ? 'Samsung SSD 980' : 'ST1000LM',
    devicePath: serial === 'S-A' ? '/dev/nvme0n1' : '/dev/sda',
  },
  operatorName: 'J Smith',
  auditedBy: { name: 'Station' },
  createdAt: at(m),
  ...extra,
});

type Row = ReturnType<typeof drive>;
type Where = { assetId: unknown; dataWipeStatus: unknown };
const matches = (cond: unknown, value: unknown) =>
  cond instanceof FindOperator
    ? (cond.value as unknown[]).includes(value)
    : cond === value;

function service(
  rows: Row[],
  asset: Record<string, unknown> = {},
  lotsTheManagerMaySee = 1,
) {
  const a = {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    tag: 'T-1',
    batchId: 'b1',
    serialNumber: 'SN-1',
    hardwareProfile: PROFILE,
    ...asset,
  };
  const qb = {
    addSelect: () => qb,
    where: () => qb,
    getOne: () => Promise.resolve(a),
    getMany: () => Promise.resolve([a]),
  };
  const svc = new CertificatesService(
    { createQueryBuilder: () => qb } as never,
    {
      find: ({ where }: { where: Where }) =>
        Promise.resolve(
          rows
            .map((r) => ({ ...r, assetId: a.id }))
            .filter(
              (r) =>
                matches(where.assetId, r.assetId) &&
                matches(where.dataWipeStatus, r.dataWipeStatus),
            ),
        ),
    } as never,
    {
      findOne: () =>
        Promise.resolve({ id: 'b1', batchNumber: 'LOT-1', ownerId: null }),
      count: () => Promise.resolve(lotsTheManagerMaySee),
    } as never,
  );
  const priv = svc as unknown as {
    render: (c: DeviceCertificate) => Promise<Buffer>;
  };
  const render = jest
    .spyOn(priv, 'render')
    .mockResolvedValue(Buffer.from('pdf'));
  return { svc, render, asset: a };
}

describe('device certificate - per drive (step 23)', () => {
  it('[A wiped, B failed] refuses the certificate and names B', async () => {
    const { svc, render, asset } = service([
      drive('S-A', DataWipeStatus.WIPED, 0),
      drive('S-B', DataWipeStatus.FAILED, 2),
    ]);
    const err = await svc.erasureCertificate(asset.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toContain('serial S-B');
    expect(render).not.toHaveBeenCalled();
  });

  it('[B failed, A wiped] - the other order - refuses too', async () => {
    const { svc, render, asset } = service([
      drive('S-B', DataWipeStatus.FAILED, 0),
      drive('S-A', DataWipeStatus.WIPED, 2),
    ]);
    await expect(svc.erasureCertificate(asset.id)).rejects.toThrow(
      BadRequestException,
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('refuses while a drive of the wipe-time profile has no record (incomplete)', async () => {
    const { svc, asset } = service([drive('S-A', DataWipeStatus.WIPED, 0)]);
    await expect(svc.erasureCertificate(asset.id)).rejects.toThrow(
      /Not every drive/,
    );
  });

  it('[A wiped, B wiped] issues ONE certificate that lists both serials', async () => {
    const { svc, render, asset } = service([
      drive('S-A', DataWipeStatus.WIPED, 0),
      drive('S-B', DataWipeStatus.WIPED, 2),
    ]);
    await svc.erasureCertificate(asset.id);
    expect(render).toHaveBeenCalledTimes(1);
    const content = render.mock.calls[0][0];
    expect(content.drives).toHaveLength(2);
    const serials = content.drives.map(
      (d) => Object.fromEntries(d.rows)['Serial number'],
    );
    expect(serials).toEqual(['S-A', 'S-B']);
    for (const d of content.drives) {
      const rows = Object.fromEntries(d.rows);
      expect(rows.Model).toBeTruthy();
      expect(rows.Method).toContain('NVMe crypto erase');
    }
  });

  it('B failed then re-wiped: certified, listing the re-wipe', async () => {
    const { svc, render, asset } = service([
      drive('S-A', DataWipeStatus.WIPED, 0),
      drive('S-B', DataWipeStatus.FAILED, 2),
      drive('S-B', DataWipeStatus.WIPED, 30, {
        dataWipeMethod: 'Overwrite — single zero pass (NIST Clear)',
      }),
    ]);
    await svc.erasureCertificate(asset.id);
    const content = render.mock.calls[0][0];
    expect(
      content.drives.map((d) => Object.fromEntries(d.rows).Method),
    ).toEqual([
      'NVMe crypto erase — verified (reads as random)',
      'Overwrite — single zero pass (NIST Clear)',
    ]);
  });

  it('keeps the certificate number derived from the latest wipe row, as before', async () => {
    const { svc, render, asset } = service([
      drive('S-A', DataWipeStatus.WIPED, 0),
      drive('S-B', DataWipeStatus.WIPED, 2, {
        createdAt: new Date('2026-09-21T09:00:00Z'),
      }),
    ]);
    await svc.erasureCertificate(asset.id);
    expect(render.mock.calls[0][0].certNo).toBe('ERA-20260921-A1B2C3D4');
  });
});

describe('GET /assets/:id/certificate-eligibility (contract C4)', () => {
  it('answers per drive, with the same refusal sentence as the certificate', async () => {
    const rows = [
      drive('S-A', DataWipeStatus.WIPED, 0),
      drive('S-B', DataWipeStatus.FAILED, 2),
    ];
    const { svc, asset } = service(rows);
    const e = await svc.eligibility(asset.id);
    expect(e).toEqual({
      available: false,
      reason: e.reason,
      verdict: 'failed',
      drives: [
        {
          key: 'serial:S-A',
          serialNumber: 'S-A',
          model: 'Samsung SSD 980',
          status: 'wiped',
          method: 'NVMe crypto erase — verified (reads as random)',
          wipedAt: at(0).toISOString(),
          manual: false,
        },
        {
          key: 'serial:S-B',
          serialNumber: 'S-B',
          model: 'ST1000LM',
          status: 'failed',
          method: 'NVMe crypto erase — verified (reads as random)',
          wipedAt: at(2).toISOString(),
          manual: false,
        },
      ],
    });
    expect(e.reason).toContain('serial S-B');
    const err = await svc.erasureCertificate(asset.id).catch((x: unknown) => x);
    expect((err as Error).message).toBe(e.reason);
  });

  it('lists a drive with no record as missing', async () => {
    const { svc, asset } = service([drive('S-A', DataWipeStatus.WIPED, 0)]);
    const e = await svc.eligibility(asset.id);
    expect(e.verdict).toBe('incomplete');
    expect(e.drives.find((d) => d.serialNumber === 'S-B')).toMatchObject({
      status: 'missing',
      method: null,
      wipedAt: null,
    });
  });

  it('available with no reason when every drive is wiped', async () => {
    const { svc, asset } = service([
      drive('S-A', DataWipeStatus.WIPED, 0),
      drive('S-B', DataWipeStatus.WIPED, 1),
    ]);
    await expect(svc.eligibility(asset.id)).resolves.toMatchObject({
      available: true,
      reason: null,
      verdict: 'wiped',
    });
  });

  it('nothing on record: verdict none, not available', async () => {
    const { svc, asset } = service([]);
    await expect(svc.eligibility(asset.id)).resolves.toMatchObject({
      available: false,
      verdict: 'none',
      drives: [],
    });
  });

  it('applies the certificate access rule: a manager outside the lot gets 404 from both', async () => {
    const manager = { userId: 'm1', role: UserRole.MANAGER };
    const denied = service([drive('S-A', DataWipeStatus.WIPED, 0)], {}, 0);
    await expect(
      denied.svc.eligibility(denied.asset.id, manager),
    ).rejects.toThrow(NotFoundException);
    await expect(
      denied.svc.erasureCertificate(denied.asset.id, manager),
    ).rejects.toThrow(NotFoundException);
    const allowed = service([drive('S-A', DataWipeStatus.WIPED, 0)], {}, 1);
    await expect(
      allowed.svc.eligibility(allowed.asset.id, manager),
    ).resolves.toMatchObject({
      verdict: 'incomplete',
    });
  });
});

describe('web asset page: certificateLinkState', () => {
  const eligible = {
    available: false,
    reason: 'A drive in this device failed its wipe.',
    verdict: 'failed' as const,
    drives: [],
  };

  it("uses the API's answer when there is one", () => {
    expect(web.certificateLinkState(eligible, [])).toEqual({
      offer: false,
      message:
        'No erasure certificate: A drive in this device failed its wipe.',
      drives: [],
    });
    expect(
      web.certificateLinkState(
        { ...eligible, available: true, reason: null, verdict: 'wiped' },
        [],
      ).offer,
    ).toBe(true);
    // No wipe at all: no link and nothing to explain, as before.
    expect(
      web.certificateLinkState(
        { ...eligible, reason: 'x', verdict: 'none' },
        [],
      ),
    ).toMatchObject({
      offer: false,
      message: null,
    });
  });

  it('an unknown answer (older API: 404) falls back to the local interim rule', () => {
    const wiped = { dataWipeStatus: 'wiped', createdAt: at(0) };
    expect(web.certificateLinkState(null, [wiped]).offer).toBe(true);
    expect(web.certificateLinkState(null, []).offer).toBe(false);
    const mixed = web.certificateLinkState(null, [
      wiped,
      { dataWipeStatus: 'failed', createdAt: at(1) },
    ]);
    expect(mixed.offer).toBe(false);
    expect(mixed.message).toMatch(/failed its wipe/);
  });
});
