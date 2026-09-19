import { BadRequestException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import * as api from './certificate-eligibility';
import { MIXED_REFUSAL, mixedNotice } from './certificate-eligibility';
// The web app's copy of the same rule. Imported by relative path on purpose:
// this spec is the one place both copies meet, so a change to either that is
// not made to the other fails here. It is pure and dependency-free.
import * as web from '../../../web/lib/certificate-eligibility';
import { isNotAnErase } from './wipe-method';
import { CertificatesService } from './certificates.service';
import { DataWipeStatus } from './asset-audit.entity';

// Remediation spec D-6, owner decision D11: a machine with one failed drive
// used to get a certificate saying every drive was erased.

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-09-10T12:00:00Z').getTime();
const at = (offsetHours: number) => new Date(T0 + offsetHours * HOUR);
const row = (
  status: 'wiped' | 'failed',
  offsetHours: number,
  method = 'NVMe crypto erase',
) => ({
  dataWipeStatus: status,
  dataWipeMethod: method,
  createdAt: at(offsetHours),
});

const CASES: Array<
  [string, ReturnType<typeof row>[], api.CertificateBlock | null]
> = [
  ['a wipe alone', [row('wiped', 0)], null],
  [
    'A failed, then B wiped (same session)',
    [row('failed', -0.1), row('wiped', 0)],
    'mixed',
  ],
  ['B wiped, then A failed', [row('wiped', 0), row('failed', 0.1)], 'mixed'],
  [
    'a failure days after the wipe',
    [row('wiped', 0), row('failed', 72)],
    'mixed',
  ],
  [
    'a failure just inside the 24 h window before',
    [row('failed', -23.9), row('wiped', 0)],
    'mixed',
  ],
  [
    'a failure more than 24 h before, superseded',
    [row('failed', -25), row('wiped', 0)],
    null,
  ],
  [
    'the newest wipe decides the window',
    [row('wiped', -48), row('failed', -30), row('wiped', 0)],
    null,
  ],
  ['nothing wiped', [row('failed', 0)], 'none'],
  ['no rows', [], 'none'],
  [
    'latest wipe was TRIM',
    [row('wiped', 0, 'Block discard / TRIM (SSD)')],
    'discard',
  ],
  [
    'TRIM is reported ahead of a failure',
    [row('wiped', 0, 'blkdiscard'), row('failed', 1)],
    'discard',
  ],
  [
    'an older TRIM superseded by a real wipe',
    [row('wiped', -5, 'TRIM'), row('wiped', 0)],
    null,
  ],
  [
    'dates as JSON strings, as the web receives them',
    [
      {
        dataWipeStatus: 'wiped',
        dataWipeMethod: 'x',
        createdAt: at(0).toISOString(),
      },
      {
        dataWipeStatus: 'failed',
        dataWipeMethod: 'x',
        createdAt: at(-1).toISOString(),
      },
    ] as never,
    'mixed',
  ],
];

describe('certificateBlock - API and web copies agree', () => {
  for (const [name, rows, expected] of CASES) {
    it(name, () => {
      expect(api.certificateBlock(rows)).toBe(expected);
      expect(web.certificateBlock(rows)).toBe(expected);
    });
  }

  it('the web copy of the discard test matches the API one', () => {
    for (const m of [
      'Block discard / TRIM (SSD)',
      'NVMe crypto erase; Block discard / TRIM (SSD)',
      'trim',
      'SSD TRIM',
      'NVMe crypto erase',
      'TRIM, then overwrite — single zero pass',
      'Degaussed; casing trimmed for recycling, then shredded',
      '',
      null,
    ]) {
      expect(web.isNotAnErase(m)).toBe(isNotAnErase(m));
    }
  });

  it('both use the same window', () => {
    expect(web.MIXED_RESULT_WINDOW_MS).toBe(api.MIXED_RESULT_WINDOW_MS);
    expect(api.MIXED_RESULT_WINDOW_MS).toBe(24 * HOUR);
  });
});

describe('mixedNotice (lot certificate)', () => {
  it('counts what the certificate left off', () => {
    expect(mixedNotice(1)).toMatch(
      /^1 further device in this lot is not listed/,
    );
    expect(mixedNotice(2)).toMatch(
      /^2 further devices in this lot are not listed/,
    );
    expect(mixedNotice(2)).toContain('not certified by this document');
  });
});

describe('the certificate routes apply the mixed-result guard', () => {
  const asset = (id: string) => ({
    id,
    tag: `T-${id}`,
    batchId: 'b1',
    serialNumber: `SN-${id}`,
    hardwareProfile: null,
  });
  const audit = (
    assetId: string,
    status: DataWipeStatus,
    offsetHours: number,
  ) => ({
    assetId,
    dataWipeStatus: status,
    dataWipeMethod: 'NVMe crypto erase',
    wipeSource: 'station',
    hardwareProfile: {},
    createdAt: at(offsetHours),
  });
  type FakeAsset = ReturnType<typeof asset>;
  type FakeAudit = ReturnType<typeof audit>;
  type Renderers = {
    render: (...args: unknown[]) => Promise<Buffer>;
    renderLot: (...args: unknown[]) => Promise<Buffer>;
  };
  type Where = { assetId: unknown; dataWipeStatus: unknown };

  // A fake repository that honours the parts of `where` the service uses -
  // assetId (a value or In([...])) and dataWipeStatus (a value or In([...])) -
  // so a query that forgot to fetch FAILED rows would really miss them.
  const matches = (cond: unknown, value: unknown) => {
    if (cond instanceof FindOperator)
      return (cond.value as unknown[]).includes(value);
    return cond === value;
  };

  function service(assets: FakeAsset[], audits: FakeAudit[]) {
    const qb = {
      addSelect: () => qb,
      where: () => qb,
      getMany: () => Promise.resolve(assets),
      getOne: () => Promise.resolve(assets[0] ?? null),
    };
    const sorted = [...audits].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const select = (where: Where) =>
      sorted.filter(
        (a) =>
          matches(where.assetId, a.assetId) &&
          matches(where.dataWipeStatus, a.dataWipeStatus),
      );
    const svc = new CertificatesService(
      { createQueryBuilder: () => qb } as never,
      {
        find: ({ where }: { where: Where }) => Promise.resolve(select(where)),
        findOne: ({ where }: { where: Where }) =>
          Promise.resolve(select(where)[0] ?? null),
      } as never,
      {
        findOne: () =>
          Promise.resolve({ id: 'b1', batchNumber: 'LOT-1', ownerId: null }),
      } as never,
    );
    const priv = svc as unknown as Renderers;
    const render = jest
      .spyOn(priv, 'render')
      .mockResolvedValue(Buffer.from('pdf'));
    const renderLot = jest
      .spyOn(priv, 'renderLot')
      .mockResolvedValue(Buffer.from('pdf'));
    return { svc, render, renderLot };
  }

  it('[A failed, B wiped] refuses the device certificate', async () => {
    const { svc, render } = service(
      [asset('a1')],
      [
        audit('a1', DataWipeStatus.FAILED, -0.2),
        audit('a1', DataWipeStatus.WIPED, 0),
      ],
    );
    await expect(svc.erasureCertificate('a1')).rejects.toThrow(
      new BadRequestException(MIXED_REFUSAL),
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('[B wiped, A failed] refuses the device certificate', async () => {
    const { svc, render } = service(
      [asset('a1')],
      [
        audit('a1', DataWipeStatus.WIPED, 0),
        audit('a1', DataWipeStatus.FAILED, 0.2),
      ],
    );
    await expect(svc.erasureCertificate('a1')).rejects.toThrow(
      new BadRequestException(MIXED_REFUSAL),
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('[A wiped] alone still produces a PDF', async () => {
    const { svc, render } = service(
      [asset('a1')],
      [audit('a1', DataWipeStatus.WIPED, 0)],
    );
    await expect(svc.erasureCertificate('a1')).resolves.toMatchObject({
      filename: 'erasure-certificate-T-a1.pdf',
    });
    expect(render).toHaveBeenCalled();
  });

  it('a failure a week before the wipe does not block it', async () => {
    const { svc, render } = service(
      [asset('a1')],
      [
        audit('a1', DataWipeStatus.FAILED, -24 * 7),
        audit('a1', DataWipeStatus.WIPED, 0),
      ],
    );
    await expect(svc.erasureCertificate('a1')).resolves.toBeDefined();
    expect(render).toHaveBeenCalled();
  });

  it('[A wiped] alone renders a real PDF end to end', async () => {
    const { svc, render } = service(
      [asset('a1')],
      [audit('a1', DataWipeStatus.WIPED, 0)],
    );
    render.mockRestore();
    const { buffer } = await svc.erasureCertificate('a1');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('leaves mixed devices off a lot certificate and counts them', async () => {
    const { svc, renderLot } = service(
      [asset('a1'), asset('a2'), asset('a3')],
      [
        audit('a1', DataWipeStatus.WIPED, 0),
        audit('a2', DataWipeStatus.WIPED, 0),
        audit('a2', DataWipeStatus.FAILED, 1),
        audit('a3', DataWipeStatus.FAILED, -1),
        audit('a3', DataWipeStatus.WIPED, 0),
      ],
    );
    await svc.lotErasureCertificate('b1');
    const [, rows, discarded, mixed] = renderLot.mock.calls[0] as [
      unknown,
      Array<{ serial: string }>,
      number,
      number,
    ];
    expect(rows.map((r) => r.serial)).toEqual(['SN-a1']);
    expect(discarded).toBe(0);
    expect(mixed).toBe(2);
  });

  it('refuses a lot where every wiped device is mixed, and says why', async () => {
    const { svc, renderLot } = service(
      [asset('a1')],
      [
        audit('a1', DataWipeStatus.WIPED, 0),
        audit('a1', DataWipeStatus.FAILED, 1),
      ],
    );
    await expect(svc.lotErasureCertificate('b1')).rejects.toThrow(
      /failed its wipe/,
    );
    expect(renderLot).not.toHaveBeenCalled();
  });
});
