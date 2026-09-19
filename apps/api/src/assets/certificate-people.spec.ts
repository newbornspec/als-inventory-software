import PDFDocument from 'pdfkit';
import { CertificatesService, erasurePeople } from './certificates.service';
import { wipeAttestation } from './manual-wipe';
import { DataWipeStatus } from './asset-audit.entity';

// Remediation spec C-1: the station signs in as one shared account, and the
// certificate printed that account as the person who performed the wipe.

describe('erasurePeople', () => {
  const station = wipeAttestation('station');
  const manual = wipeAttestation('manual');

  it('prints the typed name as self-declared, and the account as the account', () => {
    expect(erasurePeople('station', station, 'J Smith', 'Ada Admin')).toEqual([
      ['Operator (self-declared)', 'J Smith'],
      ['Filed by account', 'Ada Admin'],
    ]);
  });

  it('an older station record with no typed name prints only the account, as the account', () => {
    for (const none of [null, undefined, '', '   ']) {
      expect(erasurePeople('station', station, none, 'Ada Admin')).toEqual([
        ['Filed by account', 'Ada Admin'],
      ]);
    }
  });

  it('never labels the shared account as the performer', () => {
    const rows = erasurePeople('station', station, 'J Smith', 'Ada Admin');
    expect(rows.flat()).not.toContain('Performed by');
  });

  it('a manual record keeps its own "Recorded by" wording', () => {
    expect(erasurePeople('manual', manual, null, 'Sam Tech')).toEqual([
      ['Recorded by', 'Sam Tech'],
    ]);
  });

  it('a missing account prints a dash, not "undefined"', () => {
    expect(erasurePeople('station', station, null, null)).toEqual([
      ['Filed by account', '—'],
    ]);
  });
});

describe('the rendered certificate', () => {
  // Every string the renderer draws, in order. PDF content streams are
  // compressed, so this is the reliable way to read what was printed.
  async function printed(operatorName: string | null): Promise<string[]> {
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
      // Still draw it: the layout (and the PDF) stay real.
      return real.apply(this, args);
    });
    const asset = {
      id: 'a1b2c3d4-0000-0000-0000-000000000000',
      tag: 'T-1',
      batchId: 'b1',
      serialNumber: 'SN-1',
      hardwareProfile: null,
    };
    const wipe = {
      assetId: asset.id,
      dataWipeStatus: DataWipeStatus.WIPED,
      dataWipeMethod: 'NVMe crypto erase',
      wipeSource: 'station',
      hardwareProfile: {},
      operatorName,
      auditedBy: { name: 'Ada Admin' },
      createdAt: new Date('2026-09-10T12:00:00Z'),
    };
    const qb = {
      addSelect: () => qb,
      where: () => qb,
      getOne: () => Promise.resolve(asset),
    };
    const svc = new CertificatesService(
      { createQueryBuilder: () => qb } as never,
      {
        find: () => Promise.resolve([wipe]),
      } as never,
      {} as never,
    );
    try {
      const { buffer } = await svc.erasureCertificate(asset.id);
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    } finally {
      spy.mockRestore();
    }
    return texts;
  }

  const followedBy = (texts: string[], label: string) =>
    texts[texts.indexOf(label) + 1];

  it('shows "Operator (self-declared): J Smith" for a shared-account station wipe', async () => {
    const texts = await printed('J Smith');
    expect(texts).toContain('Operator (self-declared)');
    expect(followedBy(texts, 'Operator (self-declared)')).toBe('J Smith');
    expect(followedBy(texts, 'Filed by account')).toBe('Ada Admin');
    expect(texts).not.toContain('Performed by');
  });

  it('an older record without a typed name names only the filing account', async () => {
    const texts = await printed(null);
    expect(texts).not.toContain('Operator (self-declared)');
    expect(followedBy(texts, 'Filed by account')).toBe('Ada Admin');
    expect(texts).not.toContain('Performed by');
  });

  it('keeps the station attestation wording', async () => {
    const texts = await printed('J Smith');
    expect(texts).toContain(wipeAttestation('station').intro);
    expect(texts).toContain(wipeAttestation('station').result);
  });
});
