import { generateKeyPairSync } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { CertificateLedger, wipeKey } from './certificate-ledger';
import {
  CertificateSigner,
  type CertificateRecord,
} from './certificate-signing';
import { signedLinks } from './chain-fixture-for-spec';

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

// The public check's cost (review of step 30): anyone can call it, so a
// check must never hold the event loop for the whole chain, never fetch the
// whole chain per request, and concurrent checks must share one walk.
describe('CertificateLedger.verify - bounded chain walks', () => {
  const signer = CertificateSigner.fromEnv({
    CERT_SIGNING_KEY: Buffer.from(
      generateKeyPairSync('ed25519')
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    ).toString('base64'),
  })!;
  const LINKS = 2000;
  const links = signedLinks(signer, LINKS, null);

  // Just enough of a DataSource: the two queries verify() makes.
  function fakeDb(rows: CertificateRecord[]) {
    const raw = rows.map((r, i) => ({
      id: r.id,
      seq: String(i + 1),
      number: r.number,
      asset_id: r.assetId,
      payload: r.payload,
      payload_sha256: r.payloadSha256,
      prev_sha256: r.prevSha256,
      signature: r.signature,
      key_id: r.keyId,
      issued_at: r.issuedAt,
    }));
    const calls = { walk: 0, one: 0 };
    const query = (sql: string, params: unknown[]) => {
      if (sql.includes('seq > $1')) {
        calls.walk++;
        const after = Number(params[0]);
        const limit = Number(params[1]);
        return Promise.resolve(
          raw.filter((r) => Number(r.seq) > after).slice(0, limit),
        );
      }
      if (sql.includes('id = $1')) {
        calls.one++;
        return Promise.resolve(raw.filter((r) => r.id === params[0]));
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    return { ds: { query } as unknown as DataSource, calls, raw };
  }

  const tampered = (i: number) =>
    links.map((l, n) =>
      n === i
        ? {
            ...l,
            payload: {
              ...l.payload,
              summary: { ...l.payload.summary, model: 'Latitude 7491' },
            },
          }
        : l,
    );

  it('concurrent checks on a cold ledger share one walk, in batches that let the event loop run', async () => {
    const { ds, calls } = fakeDb(links);
    const ledger = new CertificateLedger(ds, signer);
    let ticks = 0;
    let done = false;
    const tick = () => {
      ticks++;
      if (!done) setImmediate(tick);
    };
    setImmediate(tick);
    const verdicts = await Promise.all(
      Array.from({ length: 10 }, () => ledger.verify(links[LINKS - 1].id)),
    );
    done = true;
    expect(verdicts).toEqual(Array(10).fill({ valid: true }));
    // ONE walk: 2000 / 100 full batches and the empty one that ends it.
    expect(calls.walk).toBeLessThanOrEqual(LINKS / 100 + 1);
    // Other work ran between the batches.
    expect(ticks).toBeGreaterThanOrEqual(LINKS / 100 - 1);

    // Warm: no walking at all.
    calls.walk = 0;
    expect(await ledger.verify(links[7].id)).toEqual({ valid: true });
    expect(calls.walk).toBe(0);
  });

  it('an edited certificate fails, with every later one; the walk stops there and is not repeated', async () => {
    const { ds, calls } = fakeDb(tampered(500));
    const ledger = new CertificateLedger(ds, signer);
    expect(await ledger.verify(links[499].id)).toEqual({ valid: true });
    expect(await ledger.verify(links[500].id)).toEqual({
      valid: false,
      reason: 'payload does not match its hash',
    });
    const later = await ledger.verify(links[1500].id);
    expect(later.valid).toBe(false);
    expect(!later.valid && later.reason).toMatch(/^an earlier certificate/);
    // Stopped at the break (batches of 100), and later checks reuse it.
    expect(calls.walk).toBeLessThanOrEqual(6);
  });

  it('re-checks from the start when due, in the background, and then sees an edit', async () => {
    const rows = [...links];
    const { ds, raw } = fakeDb(rows);
    const ledger = new CertificateLedger(ds, signer);
    const now = jest.spyOn(Date, 'now');
    try {
      const t0 = Date.now();
      now.mockReturnValue(t0);
      expect(await ledger.verify(links[LINKS - 1].id)).toEqual({
        valid: true,
      });
      // Someone disables the trigger and edits an old certificate.
      raw[10] = { ...raw[10], payload: tampered(10)[10].payload };
      // Within the re-check interval: still answered from the last walk.
      now.mockReturnValue(t0 + 60_000);
      expect((await ledger.verify(links[LINKS - 1].id)).valid).toBe(true);
      // Past it: this answer is still the old one (no request waits for a
      // full walk) but it starts the re-check ...
      now.mockReturnValue(t0 + 16 * 60_000);
      expect((await ledger.verify(links[LINKS - 1].id)).valid).toBe(true);
      await (ledger as unknown as { walking: Promise<void> | null }).walking;
      // ... after which the edit shows.
      expect((await ledger.verify(links[LINKS - 1].id)).valid).toBe(false);
      expect((await ledger.verify(links[9].id)).valid).toBe(true);
    } finally {
      now.mockRestore();
    }
  });
});
