import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { canonicalise } from './canonical-json';
import type { DeviceCertificate } from '../assets/certificate-content';

// Signing and checking stored erasure certificates (plan step 29, owner
// decision D29).
//
// THE KEY. An Ed25519 private key in PKCS#8 PEM, base64-encoded, in the
// Railway secret CERT_SIGNING_KEY. Nothing here generates or stores a key:
// with the variable unset, signing is OFF and certificates are exactly what
// they were before this step (built on every download, unsigned, nothing
// stored). To create one (on a trusted machine, never committed):
//   openssl genpkey -algorithm ed25519 -out cert-signing.pem
//   base64 -w0 cert-signing.pem      -> the value of CERT_SIGNING_KEY
// A raw PEM (with real or \n-escaped newlines) is accepted too.
//
// ROTATION (owner decision still open). A new key gets a new key_id, and
// every certificate records the key_id it was signed with, so old
// certificates stay checkable as long as their public key is still
// published: put retired public keys (SPKI PEM, base64, comma-separated) in
// CERT_VERIFY_PUBLIC_KEYS. The chain itself does not care which key signed
// each link.
//
// A key that is SET but unusable stops the API from starting, deliberately:
// silently issuing unsigned certificates while the owner believes they are
// signed would be worse than a failed deploy (Railway keeps the previous
// deployment serving when the new one does not come up).

export const SIGNATURE_ALGORITHM = 'Ed25519';

// key_id: the first 16 hex characters of SHA-256 over the public key's DER
// (SubjectPublicKeyInfo) encoding - short enough to print, and derivable by
// anyone who has the public key.
export function keyIdOf(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function pemFromEnv(value: string): string {
  const v = value.trim();
  if (v.includes('-----BEGIN')) return v.replace(/\\n/g, '\n');
  return Buffer.from(v, 'base64').toString('utf8');
}

export class CertificateSigner {
  readonly publicKey: KeyObject;
  readonly keyId: string;
  // Every public key a certificate may have been signed with, by key_id: the
  // current one plus any retired ones still published.
  readonly verifyKeys: Map<string, KeyObject>;

  constructor(
    private readonly privateKey: KeyObject,
    retired: KeyObject[] = [],
  ) {
    if (privateKey.asymmetricKeyType !== 'ed25519')
      throw new Error(
        `CERT_SIGNING_KEY must be an Ed25519 private key (got ${privateKey.asymmetricKeyType ?? 'unknown'})`,
      );
    this.publicKey = createPublicKey(privateKey);
    this.keyId = keyIdOf(this.publicKey);
    this.verifyKeys = new Map([[this.keyId, this.publicKey]]);
    for (const k of retired) this.verifyKeys.set(keyIdOf(k), k);
  }

  // null when CERT_SIGNING_KEY is unset or blank: signing is off.
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
  ): CertificateSigner | null {
    const raw = env.CERT_SIGNING_KEY;
    if (!raw || !raw.trim()) return null;
    let key: KeyObject;
    try {
      key = createPrivateKey(pemFromEnv(raw));
    } catch (e) {
      throw new Error(
        `CERT_SIGNING_KEY is set but is not a readable PKCS#8 PEM private key (base64-encoded): ${(e as Error).message}`,
      );
    }
    const retired = (env.CERT_VERIFY_PUBLIC_KEYS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s, i) => {
        // Same stop-the-start rule as the signing key, but with an error that
        // names the variable and the entry: a bare OpenSSL "DECODER routines::
        // unsupported" in a crash-looping deploy's log says nothing about
        // which setting to fix.
        let k: KeyObject;
        try {
          k = createPublicKey(pemFromEnv(s));
        } catch (e) {
          throw new Error(
            `CERT_VERIFY_PUBLIC_KEYS entry ${i + 1} is not a readable SPKI PEM public key (base64-encoded, entries separated by commas): ${(e as Error).message}`,
          );
        }
        if (k.asymmetricKeyType !== 'ed25519')
          throw new Error(
            `CERT_VERIFY_PUBLIC_KEYS entry ${i + 1} is not an Ed25519 public key (got ${k.asymmetricKeyType ?? 'unknown'}); it may hold Ed25519 keys only`,
          );
        return k;
      });
    return new CertificateSigner(key, retired);
  }

  sign(bytes: Buffer): string {
    return sign(null, bytes, this.privateKey).toString('base64');
  }

  // What GET /verify/keys publishes.
  publishedKeys(): PublishedKey[] {
    return [...this.verifyKeys].map(([keyId, k]) => ({
      keyId,
      algorithm: SIGNATURE_ALGORITHM,
      publicKeyPem: k.export({ type: 'spki', format: 'pem' }).toString(),
    }));
  }
}

export interface PublishedKey {
  keyId: string;
  algorithm: string;
  publicKeyPem: string;
}

// What the public check may show (owner decision D30): no serials, names or
// customer data. Worked out when the certificate is issued and signed with
// it, so the public answer is part of what the signature covers.
export interface CertificateSummary {
  make: string | null;
  model: string | null;
  driveCount: number;
  // The weakest NIST SP 800-88 level any listed drive reached; null when a
  // drive's record does not say ("not assessed").
  sanitisationLevel: 'purge' | 'clear' | 'none' | null;
}

// Everything the hash and signature cover. `id`, `number`, `issuedAt`,
// `prevSha256` and `keyId` are repeated in their own columns for lookups;
// verification checks that the two agree, so neither can be edited alone.
export interface CertificatePayload {
  v: 1;
  id: string;
  number: string;
  assetId: string;
  issuedAt: string; // ISO-8601, UTC
  prevSha256: string | null;
  keyId: string;
  // The erasures the certificate covers, one key per drive (drive, outcome,
  // method and wipe time - wipeKey in certificate-ledger.ts), sorted. A later
  // wipe of the machine changes this set, which is what makes it a NEW
  // certificate rather than the old one reprinted; the same wipe filed twice
  // does not.
  sources: string[];
  certificate: DeviceCertificate;
  summary: CertificateSummary;
}

// A stored certificate, as the ledger and the verifier see it.
export interface CertificateRecord {
  id: string;
  number: string;
  assetId: string;
  issuedAt: Date | string;
  payload: CertificatePayload;
  payloadSha256: string;
  prevSha256: string | null;
  signature: string;
  keyId: string;
}

export function canonicalBytes(payload: unknown): Buffer {
  return Buffer.from(canonicalise(payload), 'utf8');
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type Verdict = { valid: true } | { valid: false; reason: string };

// One certificate on its own: its payload hashes to the stored hash, the
// signature over the canonical payload checks out under the key it names,
// and the columns agree with the signed payload.
export function verifyRecord(
  rec: CertificateRecord,
  keys: Map<string, KeyObject>,
): Verdict {
  const p = rec.payload;
  if (!p || typeof p !== 'object')
    return { valid: false, reason: 'no payload' };
  let bytes: Buffer;
  try {
    bytes = canonicalBytes(p);
  } catch {
    return { valid: false, reason: 'payload cannot be canonicalised' };
  }
  if (sha256Hex(bytes) !== rec.payloadSha256)
    return { valid: false, reason: 'payload does not match its hash' };
  if (
    p.id !== rec.id ||
    p.number !== rec.number ||
    p.assetId !== rec.assetId ||
    p.keyId !== rec.keyId ||
    (p.prevSha256 ?? null) !== (rec.prevSha256 ?? null) ||
    new Date(p.issuedAt).getTime() !== new Date(rec.issuedAt).getTime()
  )
    return { valid: false, reason: 'record does not match its signed payload' };
  const key = keys.get(rec.keyId);
  if (!key) return { valid: false, reason: `unknown signing key ${rec.keyId}` };
  let ok = false;
  try {
    ok = verify(null, bytes, key, Buffer.from(rec.signature, 'base64'));
  } catch {
    ok = false;
  }
  return ok ? { valid: true } : { valid: false, reason: 'bad signature' };
}

// A certificate and its whole history: `chain` is the certificate itself
// followed by each predecessor in turn (chain[i + 1] is the one chain[i]
// names as prev). Every link must verify on its own AND chain[i].prevSha256
// must equal the hash RECOMPUTED from chain[i + 1]'s payload - so editing
// any earlier certificate, even with its stored hash "fixed up" to match,
// breaks every certificate issued after it. The walk ends at the first
// certificate (prev null) or, when `trusted` is given, at a certificate
// already verified back to the start (a checkpoint).
export function verifyChain(
  chain: CertificateRecord[],
  keys: Map<string, KeyObject>,
  trusted?: (sha256: string) => boolean,
): Verdict {
  if (!chain.length) return { valid: false, reason: 'not found' };
  for (let i = 0; i < chain.length; i++) {
    const rec = chain[i];
    const own = verifyRecord(rec, keys);
    if (!own.valid)
      return {
        valid: false,
        reason: i === 0 ? own.reason : `an earlier certificate: ${own.reason}`,
      };
    // A checkpoint is trusted only for the certificates BEFORE it; the
    // certificate asked about is always checked in full.
    if (i > 0 && trusted?.(rec.payloadSha256)) return { valid: true };
    if (rec.prevSha256 === null) {
      return i === chain.length - 1
        ? { valid: true }
        : { valid: false, reason: 'chain continues past its start' };
    }
    const prev = chain[i + 1];
    if (!prev) return { valid: false, reason: 'chain is broken' };
    if (sha256Hex(canonicalBytes(prev.payload)) !== rec.prevSha256)
      return { valid: false, reason: 'chain is broken' };
  }
  return { valid: false, reason: 'chain is broken' };
}
