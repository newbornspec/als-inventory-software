import { BadRequestException } from '@nestjs/common';
import {
  DISCARD_NOTE,
  DISCARD_REFUSAL,
  discardedNotice,
  downgradeDiscardClaim,
  isNotAnErase,
} from './wipe-method';
import { CertificatesService } from './certificates.service';
import { AssetAuditStatus } from './asset.entity';
import { DataWipeStatus } from './asset-audit.entity';
import { deriveAuditStatus } from '../devices/devices.service';
import type { IngestAuditDto } from '../devices/dto/ingest-audit.dto';

// Remediation spec D-1: a block discard (TRIM) was certified as a wipe. The
// station stopped doing it in 771bc40; these pin the doors that must refuse
// what it already wrote, and what an old stick can still send.

// Exactly what the pre-771bc40 engine recorded, in both of its paths.
const OLD_TRIM = 'Block discard / TRIM (SSD)';

describe('isNotAnErase', () => {
  it('refuses the method the old station recorded', () => {
    expect(isNotAnErase(OLD_TRIM)).toBe(true);
  });

  it('refuses a multi-drive record where any one drive was only discarded', () => {
    // The text-mode wipe joined drives with "; " - one TRIMmed drive leaves
    // the machine unsanitised however the others went.
    expect(isNotAnErase(`NVMe crypto erase; ${OLD_TRIM}`)).toBe(true);
  });

  it('refuses it however it is spelled by hand', () => {
    for (const m of [
      'TRIM',
      'trim',
      'blkdiscard',
      'block discard',
      'SSD TRIM',
    ]) {
      expect(isNotAnErase(m)).toBe(true);
    }
  });

  it('accepts every real method the station records', () => {
    for (const m of [
      'NVMe crypto erase',
      'NVMe block erase',
      'ATA secure erase (SSD)',
      'Overwrite — single zero pass (NIST Clear)',
      'Overwrite — 3 passes + zero (NIST Clear; flash: user-addressable blocks only)',
      'NIST 800-88 Purge',
    ]) {
      expect(isNotAnErase(m)).toBe(false);
    }
  });

  it('accepts discard as a pre-step to a real erase, which the spec allows', () => {
    expect(isNotAnErase('TRIM, then overwrite — single zero pass')).toBe(false);
  });

  it('does not trip on words that merely contain "trim"', () => {
    expect(
      isNotAnErase('Degaussed; casing trimmed for recycling, then shredded'),
    ).toBe(false);
    expect(isNotAnErase('Physically destroyed')).toBe(false);
  });

  it('says nothing about a missing method', () => {
    expect(isNotAnErase(null)).toBe(false);
    expect(isNotAnErase(undefined)).toBe(false);
    expect(isNotAnErase('')).toBe(false);
  });
});

describe('downgradeDiscardClaim (station ingest)', () => {
  const dto = (over: Partial<IngestAuditDto>) => ({ ...over });

  it('files an old stick\'s TRIM "wipe" as FAILED, keeping the method and saying why', () => {
    const out = downgradeDiscardClaim(
      dto({ dataWipeStatus: DataWipeStatus.WIPED, dataWipeMethod: OLD_TRIM }),
    );
    expect(out.dataWipeStatus).toBe(DataWipeStatus.FAILED);
    expect(out.dataWipeMethod).toBe(OLD_TRIM);
    expect(out.notes).toBe(DISCARD_NOTE);
  });

  it('never lets it reach the device as data_wiped', () => {
    const out = downgradeDiscardClaim(
      dto({ dataWipeStatus: DataWipeStatus.WIPED, dataWipeMethod: OLD_TRIM }),
    );
    expect(deriveAuditStatus(out)).toBe(AssetAuditStatus.DATA_WIPE_FAILED);
    const explicit = downgradeDiscardClaim(
      dto({
        dataWipeStatus: DataWipeStatus.WIPED,
        dataWipeMethod: OLD_TRIM,
        auditStatus: AssetAuditStatus.DATA_WIPED,
      }),
    );
    expect(explicit.auditStatus).toBe(AssetAuditStatus.DATA_WIPE_FAILED);
  });

  it("keeps the operator's own notes", () => {
    const out = downgradeDiscardClaim(
      dto({
        dataWipeStatus: DataWipeStatus.WIPED,
        dataWipeMethod: OLD_TRIM,
        notes: 'Bay 3',
      }),
    );
    expect(out.notes).toBe(`Bay 3\n${DISCARD_NOTE}`);
  });

  it('leaves real wipes, and failures, exactly as they came', () => {
    const real = dto({
      dataWipeStatus: DataWipeStatus.WIPED,
      dataWipeMethod: 'NVMe crypto erase',
    });
    expect(downgradeDiscardClaim(real)).toBe(real);
    const failed = dto({
      dataWipeStatus: DataWipeStatus.FAILED,
      dataWipeMethod: OLD_TRIM,
    });
    expect(downgradeDiscardClaim(failed)).toBe(failed);
  });
});

describe('discardedNotice (lot certificate)', () => {
  it('counts what the certificate left off, in words that fit the number', () => {
    expect(discardedNotice(1)).toMatch(
      /^1 further device in this lot is not listed/,
    );
    expect(discardedNotice(3)).toMatch(
      /^3 further devices in this lot are not listed/,
    );
    expect(discardedNotice(3)).toContain('not certified by this document');
  });
});

describe('the certificate routes refuse a discard', () => {
  const asset = (id: string) => ({
    id,
    tag: `T-${id}`,
    batchId: 'b1',
    serialNumber: `SN-${id}`,
    hardwareProfile: null,
  });
  const wipe = (assetId: string, method: string, day: number) => ({
    assetId,
    dataWipeStatus: DataWipeStatus.WIPED,
    dataWipeMethod: method,
    wipeSource: 'station',
    hardwareProfile: {},
    createdAt: new Date(2026, 8, day),
  });

  type FakeAsset = ReturnType<typeof asset>;
  type FakeWipe = ReturnType<typeof wipe>;
  // The two private renderers, reached for spying without any-casts.
  type Renderers = {
    render: (...args: unknown[]) => Promise<Buffer>;
    renderLot: (...args: unknown[]) => Promise<Buffer>;
  };

  function service(assets: FakeAsset[], wipes: FakeWipe[]) {
    const qb = {
      addSelect: () => qb,
      where: () => qb,
      getMany: () => Promise.resolve(assets),
      getOne: () => Promise.resolve(assets[0] ?? null),
    };
    // Newest first, as the real queries order them.
    const sorted = [...wipes].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const svc = new CertificatesService(
      { createQueryBuilder: () => qb } as never,
      {
        find: () => Promise.resolve(sorted),
        findOne: ({ where }: { where: { assetId: string } }) =>
          Promise.resolve(
            sorted.find((w) => w.assetId === where.assetId) ?? null,
          ),
      } as never,
      {
        findOne: () =>
          Promise.resolve({ id: 'b1', batchNumber: 'LOT-1', ownerId: null }),
      } as never,
    );
    const priv = svc as unknown as Renderers;
    const renderLot = jest
      .spyOn(priv, 'renderLot')
      .mockResolvedValue(Buffer.from('pdf'));
    const render = jest
      .spyOn(priv, 'render')
      .mockResolvedValue(Buffer.from('pdf'));
    return { svc, renderLot, render };
  }

  it('refuses a device certificate when the latest wipe was a discard', async () => {
    const { svc, render } = service([asset('a1')], [wipe('a1', OLD_TRIM, 10)]);
    await expect(svc.erasureCertificate('a1')).rejects.toThrow(
      new BadRequestException(DISCARD_REFUSAL),
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('judges the LATEST wipe: a later discard is not rescued by an older real wipe', async () => {
    const { svc } = service(
      [asset('a1')],
      [wipe('a1', 'NVMe crypto erase', 1), wipe('a1', OLD_TRIM, 10)],
    );
    await expect(svc.erasureCertificate('a1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('still certifies a real wipe that came after a discard', async () => {
    const { svc, render } = service(
      [asset('a1')],
      [wipe('a1', OLD_TRIM, 1), wipe('a1', 'NVMe crypto erase', 10)],
    );
    await expect(svc.erasureCertificate('a1')).resolves.toMatchObject({
      filename: 'erasure-certificate-T-a1.pdf',
    });
    expect(render).toHaveBeenCalled();
  });

  it('leaves discarded devices off a lot certificate and tells the renderer how many', async () => {
    const { svc, renderLot } = service(
      [asset('a1'), asset('a2'), asset('a3')],
      [
        wipe('a1', 'NVMe crypto erase', 5),
        wipe('a2', OLD_TRIM, 5),
        wipe('a3', `ATA secure erase (SSD); ${OLD_TRIM}`, 5),
      ],
    );
    await svc.lotErasureCertificate('b1');
    const [, rows, , notices] = renderLot.mock.calls[0] as [
      unknown,
      Array<{ serial: string }>,
      unknown,
      string[],
    ];
    expect(rows.map((r) => r.serial)).toEqual(['SN-a1']);
    expect(notices).toEqual([discardedNotice(2)]);
  });

  it('refuses a lot whose only wipes were discards, and says that is why', async () => {
    const { svc, renderLot } = service(
      [asset('a1'), asset('a2')],
      [wipe('a1', OLD_TRIM, 5), wipe('a2', OLD_TRIM, 5)],
    );
    await expect(svc.lotErasureCertificate('b1')).rejects.toThrow(
      /block discards \(TRIM\)/,
    );
    expect(renderLot).not.toHaveBeenCalled();
  });
});
