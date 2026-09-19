import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { canonicalise, storable } from './canonical-json';
import {
  CertificateSigner,
  canonicalBytes,
  keyIdOf,
  sha256Hex,
  verifyChain,
  verifyRecord,
  type CertificatePayload,
  type CertificateRecord,
} from './certificate-signing';

// Plan step 29: the pure half of signed certificates - canonical bytes, the
// Ed25519 signature, and the hash chain - with a key generated for the test
// (no real key exists in the repo, owner decision D29).

const pemB64 = (k: KeyObject) =>
  Buffer.from(k.export({ type: 'pkcs8', format: 'pem' }).toString()).toString(
    'base64',
  );

function testSigner(): CertificateSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return CertificateSigner.fromEnv({ CERT_SIGNING_KEY: pemB64(privateKey) })!;
}

// Issue a chain of n certificates the way the ledger does.
function issueChain(signer: CertificateSigner, n: number): CertificateRecord[] {
  const out: CertificateRecord[] = [];
  for (let i = 0; i < n; i++) {
    const prev = out[i - 1]?.payloadSha256 ?? null;
    const payload = storable({
      v: 1,
      id: `00000000-0000-4000-8000-00000000000${i}`,
      number: `ERA-20260919-A${i}`,
      assetId: `aaaaaaaa-0000-4000-8000-00000000000${i}`,
      issuedAt: new Date(Date.UTC(2026, 8, 19, 10, i)).toISOString(),
      prevSha256: prev,
      keyId: signer.keyId,
      sources: [`r${i}`],
      certificate: {
        certNo: `ERA-20260919-A${i}`,
        intro: 'This certifies…',
        device: [['Model', 'Latitude 7490']],
        erasure: [],
        drives: [
          {
            title: 'Storage medium erased',
            rows: [['Serial number', `S-${i}`]],
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
    }) as CertificatePayload;
    const bytes = canonicalBytes(payload);
    out.push({
      id: payload.id,
      number: payload.number,
      assetId: payload.assetId,
      issuedAt: new Date(payload.issuedAt),
      payload,
      payloadSha256: sha256Hex(bytes),
      prevSha256: prev,
      signature: signer.sign(bytes),
      keyId: signer.keyId,
    });
  }
  return out;
}

// chain for certificate i: itself, then each predecessor.
const chainOf = (all: CertificateRecord[], i: number) =>
  all.slice(0, i + 1).reverse();

// jsonb hands values back with keys in its own order; the canonical form
// must not care.
function reorder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reorder);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .reverse()
        .map(([k, x]) => [k, reorder(x)]),
    );
  return v;
}

describe('canonicalise', () => {
  it('sorts keys at every depth and writes no whitespace', () => {
    expect(
      canonicalise({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } }),
    ).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  });

  it('is the same for the same value in any key order', () => {
    const v = { number: 'ERA-1', nested: { b: 2, a: [1, 'two'] }, é: 'ü' };
    expect(canonicalise(reorder(v))).toBe(canonicalise(v));
  });

  it('drops undefined keys like JSON.stringify, refuses what JSON cannot carry', () => {
    expect(canonicalise({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalise(-0)).toBe('0');
    for (const bad of [NaN, Infinity, [undefined], 10n, () => 1])
      expect(() => canonicalise(bad)).toThrow(TypeError);
  });

  it('escapes strings as JSON does', () => {
    expect(canonicalise('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
  });

  it('storable: dates become ISO strings, NUL (which jsonb refuses) becomes U+FFFD', () => {
    expect(
      storable({
        at: new Date('2026-09-19T10:00:00Z'),
        m: `SSD${String.fromCharCode(0)}X`,
        u: undefined,
      }),
    ).toEqual({
      at: '2026-09-19T10:00:00.000Z',
      m: `SSD${String.fromCharCode(0xfffd)}X`,
    });
  });
});

describe('CertificateSigner.fromEnv', () => {
  it('unset or blank: null - signing is off', () => {
    expect(CertificateSigner.fromEnv({})).toBeNull();
    expect(CertificateSigner.fromEnv({ CERT_SIGNING_KEY: '  ' })).toBeNull();
  });

  it('reads a base64 PKCS#8 PEM, or a raw PEM; key_id is 16 hex of SHA-256 over the public DER', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const expected = createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
      .slice(0, 16);
    for (const value of [pemB64(privateKey), pem, pem.replace(/\n/g, '\\n')]) {
      const s = CertificateSigner.fromEnv({ CERT_SIGNING_KEY: value })!;
      expect(s.keyId).toBe(expected);
      expect(keyIdOf(publicKey)).toBe(expected);
    }
  });

  it('a key that is set but unusable refuses to start, rather than silently not signing', () => {
    expect(() =>
      CertificateSigner.fromEnv({ CERT_SIGNING_KEY: 'not a key' }),
    ).toThrow(/CERT_SIGNING_KEY/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    expect(() =>
      CertificateSigner.fromEnv({ CERT_SIGNING_KEY: pemB64(rsa) }),
    ).toThrow(/Ed25519/);
  });

  // Cross-check, wave 2: a bad retired key also stops the API starting (as
  // it should), but used to do so with a bare OpenSSL error that did not
  // name the variable - on a crash-looping deploy, the owner has only the
  // log line to go on.
  it('an unreadable retired key names CERT_VERIFY_PUBLIC_KEYS and which entry', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const good = Buffer.from(
      generateKeyPairSync('ed25519')
        .publicKey.export({ type: 'spki', format: 'pem' })
        .toString(),
    ).toString('base64');
    for (const bad of [`${good},not a key`, `${good}, , AAAA`])
      expect(() =>
        CertificateSigner.fromEnv({
          CERT_SIGNING_KEY: pemB64(privateKey),
          CERT_VERIFY_PUBLIC_KEYS: bad,
        }),
      ).toThrow(/CERT_VERIFY_PUBLIC_KEYS entry 2 .*not a readable/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
    expect(() =>
      CertificateSigner.fromEnv({
        CERT_SIGNING_KEY: pemB64(privateKey),
        CERT_VERIFY_PUBLIC_KEYS: Buffer.from(
          rsa.export({ type: 'spki', format: 'pem' }).toString(),
        ).toString('base64'),
      }),
    ).toThrow(/CERT_VERIFY_PUBLIC_KEYS entry 1 .*Ed25519/);
  });

  it('publishes retired public keys by key_id for old certificates', () => {
    const old = generateKeyPairSync('ed25519').publicKey;
    const { privateKey } = generateKeyPairSync('ed25519');
    const s = CertificateSigner.fromEnv({
      CERT_SIGNING_KEY: pemB64(privateKey),
      CERT_VERIFY_PUBLIC_KEYS: Buffer.from(
        old.export({ type: 'spki', format: 'pem' }).toString(),
      ).toString('base64'),
    })!;
    expect(
      s
        .publishedKeys()
        .map((k) => k.keyId)
        .sort(),
    ).toEqual([s.keyId, keyIdOf(old)].sort());
    expect(JSON.stringify(s.publishedKeys())).not.toMatch(/PRIVATE/);
  });
});

describe('verifying stored certificates', () => {
  const signer = testSigner();
  const all = issueChain(signer, 4);

  it('every certificate verifies on its own and back to the start of the chain', () => {
    for (let i = 0; i < all.length; i++) {
      expect(verifyRecord(all[i], signer.verifyKeys)).toEqual({ valid: true });
      expect(verifyChain(chainOf(all, i), signer.verifyKeys)).toEqual({
        valid: true,
      });
    }
  });

  it('survives a jsonb round trip (keys reordered)', () => {
    const back = all.map((r) => ({
      ...r,
      payload: reorder(r.payload) as CertificatePayload,
    }));
    expect(verifyChain(chainOf(back, 3), signer.verifyKeys)).toEqual({
      valid: true,
    });
  });

  it('changing ONE byte of a stored payload breaks that certificate and every later one', () => {
    const tampered = all.map((r) => ({ ...r, payload: storable(r.payload) }));
    const drive = tampered[1].payload.certificate.drives[0].rows[0];
    drive[1] = 'S-X'; // 'S-1' -> 'S-X': one byte
    expect(verifyChain(chainOf(tampered, 0), signer.verifyKeys).valid).toBe(
      true,
    );
    for (const i of [1, 2, 3]) {
      const v = verifyChain(chainOf(tampered, i), signer.verifyKeys);
      expect(v.valid).toBe(false);
    }
  });

  it('...even when the tamperer also rewrites the stored hash', () => {
    const tampered = all.map((r) => ({ ...r, payload: storable(r.payload) }));
    tampered[1].payload.summary.driveCount = 2;
    tampered[1].payloadSha256 = sha256Hex(canonicalBytes(tampered[1].payload));
    for (const i of [1, 2, 3])
      expect(verifyChain(chainOf(tampered, i), signer.verifyKeys).valid).toBe(
        false,
      );
  });

  it('a column edited without the payload (number, issued date) fails', () => {
    expect(
      verifyRecord({ ...all[2], number: 'ERA-OTHER' }, signer.verifyKeys).valid,
    ).toBe(false);
    expect(
      verifyRecord(
        { ...all[2], issuedAt: new Date('2030-01-01') },
        signer.verifyKeys,
      ).valid,
    ).toBe(false);
  });

  it('a signature from another key, or an unknown key, fails', () => {
    const other = testSigner();
    expect(verifyRecord(all[0], other.verifyKeys)).toEqual({
      valid: false,
      reason: `unknown signing key ${signer.keyId}`,
    });
    const forged = {
      ...all[0],
      signature: other.sign(canonicalBytes(all[0].payload)),
    };
    expect(verifyRecord(forged, signer.verifyKeys)).toEqual({
      valid: false,
      reason: 'bad signature',
    });
  });

  it('a missing predecessor breaks the chain; a checkpoint ends the walk early', () => {
    expect(
      verifyChain(chainOf(all, 3).slice(0, 2), signer.verifyKeys).valid,
    ).toBe(false);
    const trusted = (h: string) => h === all[2].payloadSha256;
    expect(
      verifyChain(chainOf(all, 3).slice(0, 2), signer.verifyKeys, trusted),
    ).toEqual({
      valid: true,
    });
    // The certificate asked about is never taken on trust.
    const bad = { ...all[3], signature: all[2].signature };
    expect(
      verifyChain([bad, all[2]], signer.verifyKeys, () => true).valid,
    ).toBe(false);
  });
});
