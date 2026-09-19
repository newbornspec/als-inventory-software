import { wipeKey } from './certificate-ledger';

// Which wipe records are the SAME erasure (review of plan step 29): a
// retried upload must reuse the certificate, a real re-wipe must not.
describe('wipeKey', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: 'r1',
      dataWipeStatus: 'wiped',
      dataWipeMethod: 'NVMe crypto erase — verified (reads as random)',
      createdAt: new Date('2026-09-19T09:00:05Z'),
      wipedAt: new Date('2026-09-19T09:00:00Z'),
      wipedDriveSerial: 'S5H2NS0N',
      wipedDrive: {
        serialNumber: 'S5H2NS0N',
        model: 'Samsung SSD 980',
        sizeBytes: 512110190592,
        devicePath: '/dev/nvme0n1',
      },
      ...over,
    }) as never;

  it('the same wipe filed again (new row, received later) is the same key', () => {
    expect(
      wipeKey(row({ id: 'r2', createdAt: new Date('2026-09-21T17:00:00Z') })),
    ).toBe(wipeKey(row()));
    // wipedAt as the ISO string an API row may hold instead of a Date.
    expect(wipeKey(row({ wipedAt: '2026-09-19T09:00:00.000Z' }))).toBe(
      wipeKey(row()),
    );
  });

  it('a re-wipe (new wipedAt), another drive, another outcome or method is a new key', () => {
    const base = wipeKey(row());
    for (const over of [
      { wipedAt: new Date('2026-09-19T09:30:00Z') },
      { wipedDriveSerial: 'OTHER', wipedDrive: { serialNumber: 'OTHER' } },
      { dataWipeStatus: 'failed' },
      { dataWipeMethod: 'Single-pass overwrite' },
    ])
      expect(wipeKey(row(over))).not.toBe(base);
  });

  it('rows without wipedAt (old sticks) are keyed by the day received', () => {
    const legacy = (createdAt: string, id = 'x') =>
      wipeKey(
        row({
          id,
          wipedAt: null,
          wipedDriveSerial: null,
          wipedDrive: null,
          createdAt: new Date(createdAt),
        }),
      );
    expect(legacy('2026-09-19T10:00:00', 'a')).toBe(
      legacy('2026-09-19T16:00:00', 'b'),
    );
    expect(legacy('2026-09-19T10:00:00')).not.toBe(
      legacy('2026-09-20T10:00:00'),
    );
  });
});
