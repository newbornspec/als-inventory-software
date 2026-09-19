import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { HttpException } from '@nestjs/common';
import { storable } from './canonical-json';
import {
  CertificateSigner,
  canonicalBytes,
  sha256Hex,
  verifyRecord,
  type CertificatePayload,
} from './certificate-signing';
import type { CertificateLedger } from './certificate-ledger';
import type { ErasureCertificate } from './erasure-certificate.entity';
import { publicVerifyEnabled, verifyUrlFor } from './public-verify';
import { clientAddress, RateLimiter } from './rate-limit';
import { VerifyController } from './verify.controller';

// Plan step 30 (owner decision D30): the public certificate check - off by
// default, minimal data, random ids, rate limited - and the offline
// verifier script that needs nothing but node:crypto.

const SCRIPT = path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'verify-certificate.mjs',
);

const signer = CertificateSigner.fromEnv({
  CERT_SIGNING_KEY: Buffer.from(
    generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  ).toString('base64'),
})!;

// A certificate issued the way the ledger issues one, full of the details
// the public check must NOT reveal.
function issued(prevSha256: string | null = null): ErasureCertificate {
  const id = randomUUID();
  const issuedAt = new Date('2026-09-19T10:01:07.123Z');
  const payload = storable<CertificatePayload>({
    v: 1,
    id,
    number: 'ERA-20260919-A1B2C3D4',
    assetId: 'a1b2c3d4-0000-4000-8000-000000000000',
    issuedAt: issuedAt.toISOString(),
    prevSha256,
    keyId: signer.keyId,
    sources: ['r1'],
    certificate: {
      certNo: 'ERA-20260919-A1B2C3D4',
      intro: 'This certifies that the storage medium identified below…',
      device: [
        ['Manufacturer', 'Dell'],
        ['Model', 'Latitude 7490'],
        ['Serial number', 'HOST-SECRET-1'],
        ['Asset tag', 'TAG-SECRET'],
      ],
      erasure: [['Storage media erased', '1']],
      drives: [
        {
          title: 'Storage medium erased',
          rows: [
            ['Serial number', 'DRIVE-SECRET-1'],
            ['Operator (self-declared)', 'Jane Secretname'],
          ],
        },
      ],
      notices: [],
      extra: [],
      footer: '',
    },
    summary: {
      make: 'Dell',
      model: 'Latitude 7490',
      driveCount: 1,
      sanitisationLevel: 'purge',
    },
  });
  const bytes = canonicalBytes(payload);
  return {
    id,
    seq: '1',
    number: payload.number,
    assetId: payload.assetId,
    payload,
    payloadSha256: sha256Hex(bytes),
    prevSha256,
    signature: signer.sign(bytes),
    keyId: signer.keyId,
    issuedAt,
  };
}

function ledgerWith(certs: ErasureCertificate[]): CertificateLedger {
  return {
    signer,
    enabled: true,
    find: (id: string) =>
      Promise.resolve(certs.find((c) => c.id === id) ?? null),
    // The controller passes the row it already read.
    verify: (target: string | ErasureCertificate) => {
      const id = typeof target === 'string' ? target : target.id;
      const c = certs.find((x) => x.id === id)!;
      return Promise.resolve(verifyRecord(c, signer.verifyKeys));
    },
  } as unknown as CertificateLedger;
}

const req = (ip = '203.0.113.7', accept = 'application/json') =>
  ({
    headers: { accept, 'x-forwarded-for': `10.0.0.1, ${ip}` },
    ip: '100.64.0.1',
  }) as never;
const res = () => ({ type: jest.fn() }) as never;
const status = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 200;
  } catch (e) {
    return e instanceof HttpException ? e.getStatus() : 500;
  }
};

describe('GET /verify (step 30)', () => {
  const saved = process.env.PUBLIC_VERIFY_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.PUBLIC_VERIFY_ENABLED;
    else process.env.PUBLIC_VERIFY_ENABLED = saved;
  });

  it('is OFF by default: both routes 404', async () => {
    delete process.env.PUBLIC_VERIFY_ENABLED;
    expect(publicVerifyEnabled()).toBe(false);
    const cert = issued();
    const c = new VerifyController(ledgerWith([cert]));
    expect(await status(() => c.keys(req()))).toBe(404);
    expect(await status(c.check(cert.id, req(), res()))).toBe(404);
    for (const v of ['0', 'true', 'yes', '']) {
      process.env.PUBLIC_VERIFY_ENABLED = v;
      expect(await status(c.check(cert.id, req(), res()))).toBe(404);
    }
  });

  describe('when PUBLIC_VERIFY_ENABLED=1', () => {
    beforeEach(() => {
      process.env.PUBLIC_VERIFY_ENABLED = '1';
    });

    it('/verify/keys publishes the public keys by key_id, nothing private', () => {
      const out = new VerifyController(ledgerWith([])).keys(req());
      expect(out.keys).toEqual([
        expect.objectContaining({ keyId: signer.keyId, algorithm: 'Ed25519' }),
      ]);
      expect(out.keys[0].publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
      expect(JSON.stringify(out)).not.toMatch(/PRIVATE/);
    });

    it('returns ONLY valid, number, issued date, make/model, drive count and level', async () => {
      const cert = issued();
      const out = await new VerifyController(ledgerWith([cert])).check(
        cert.id,
        req(),
        res(),
      );
      expect(out).toEqual({
        valid: true,
        certificateNumber: 'ERA-20260919-A1B2C3D4',
        issuedDate: '2026-09-19',
        device: { make: 'Dell', model: 'Latitude 7490' },
        driveCount: 1,
        sanitisationLevel: 'purge',
      });
      expect(JSON.stringify(out)).not.toMatch(
        /SECRET|Secretname|a1b2c3d4-0000/,
      );
    });

    it('a guessed or malformed id is a 404', async () => {
      const c = new VerifyController(ledgerWith([issued()]));
      for (const id of [
        randomUUID(),
        randomUUID(),
        'ERA-20260919-A1B2C3D4',
        '1',
        "' or 1=1 --",
      ])
        expect(await status(c.check(id, req(), res()))).toBe(404);
    });

    it('a tampered certificate answers invalid', async () => {
      const cert = issued();
      cert.payload.summary.driveCount = 2;
      const out = await new VerifyController(ledgerWith([cert])).check(
        cert.id,
        req(),
        res(),
      );
      expect((out as { valid: boolean }).valid).toBe(false);
    });

    it('a browser (the QR code) gets a plain PASS page with the same minimal facts', async () => {
      const cert = issued();
      const r = res();
      const html = (await new VerifyController(ledgerWith([cert])).check(
        cert.id,
        req('203.0.113.9', 'text/html,application/xhtml+xml'),
        r,
      )) as string;
      expect((r as unknown as { type: jest.Mock }).type).toHaveBeenCalledWith(
        'html',
      );
      expect(html).toContain('PASS');
      expect(html).toContain('ERA-20260919-A1B2C3D4');
      expect(html).not.toMatch(/SECRET|Secretname|<script/i);
    });

    it('rate limits each caller (30 a minute), by the address the proxy appended', async () => {
      const cert = issued();
      const c = new VerifyController(ledgerWith([cert]));
      for (let i = 0; i < 30; i++)
        expect(await status(c.check(cert.id, req('198.51.100.1'), res()))).toBe(
          200,
        );
      expect(await status(c.check(cert.id, req('198.51.100.1'), res()))).toBe(
        429,
      );
      expect(await status(() => c.keys(req('198.51.100.1')))).toBe(429);
      // Another caller is unaffected.
      expect(await status(c.check(cert.id, req('198.51.100.2'), res()))).toBe(
        200,
      );
    });
  });
});

describe('rate limiting pieces', () => {
  it('RateLimiter: a fixed window per key', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect([rl.take('a'), rl.take('a'), rl.take('a'), rl.take('b')]).toEqual([
      true,
      true,
      false,
      true,
    ]);
    t = 1000;
    expect(rl.take('a')).toBe(true);
  });

  it('clientAddress: the LAST X-Forwarded-For entry (a client cannot forge it), else the socket', () => {
    expect(
      clientAddress({
        headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
        ip: '9.9.9.9',
      }),
    ).toBe('2.2.2.2');
    expect(clientAddress({ headers: {}, ip: '9.9.9.9' })).toBe('9.9.9.9');
  });

  it('verifyUrlFor: base URL + /verify/<id>, or null without one', () => {
    expect(
      verifyUrlFor('abc', {
        PUBLIC_VERIFY_BASE_URL: 'https://api.example.com/',
      }),
    ).toBe('https://api.example.com/verify/abc');
    expect(verifyUrlFor('abc', {})).toBeNull();
  });
});

describe('scripts/verify-certificate.mjs (node:crypto only)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'als-verify-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // The record as GET /assets/:id/erasure-certificate.json hands it out.
  const exported = (c: ErasureCertificate) => ({
    id: c.id,
    number: c.number,
    assetId: c.assetId,
    issuedAt: new Date(c.issuedAt).toISOString(),
    payload: c.payload,
    payloadSha256: c.payloadSha256,
    prevSha256: c.prevSha256,
    signature: c.signature,
    keyId: c.keyId,
  });

  function run(
    cert: unknown,
    keys: unknown = { keys: signer.publishedKeys() },
  ) {
    const k = path.join(dir, `keys-${randomUUID()}.json`);
    const f = path.join(dir, `cert-${randomUUID()}.json`);
    writeFileSync(k, JSON.stringify(keys));
    writeFileSync(f, JSON.stringify(cert, null, 2));
    return spawnSync(
      process.execPath,
      [SCRIPT, '--keys', k, '--certificate', f],
      {
        encoding: 'utf8',
      },
    );
  }

  it('verifies an issued certificate', () => {
    const r = run(exported(issued('f'.repeat(64))));
    expect(r.stdout).toMatch(/^VALID - certificate ERA-20260919-A1B2C3D4/);
    expect(r.status).toBe(0);
  });

  it('rejects one changed byte, a swapped number, and an unpublished key', () => {
    const tampered = exported(issued());
    (tampered.payload.certificate.drives[0].rows[0] as string[])[1] =
      'DRIVE-SECRET-2';
    expect(run(tampered).status).toBe(1);

    const renumbered = { ...exported(issued()), number: 'ERA-OTHER' };
    const r = run(renumbered);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^INVALID/);

    const other = CertificateSigner.fromEnv({
      CERT_SIGNING_KEY: Buffer.from(
        generateKeyPairSync('ed25519')
          .privateKey.export({ type: 'pkcs8', format: 'pem' })
          .toString(),
      ).toString('base64'),
    })!;
    expect(
      run(exported(issued()), { keys: other.publishedKeys() }).status,
    ).toBe(1);
    // A key published under the wrong key id.
    expect(
      run(exported(issued()), {
        keys: [{ ...other.publishedKeys()[0], keyId: signer.keyId }],
      }).status,
    ).toBe(1);
  });

  it('usage errors exit 2', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
