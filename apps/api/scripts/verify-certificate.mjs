#!/usr/bin/env node
// Check an ALS Certificate of Data Erasure independently (plan step 30).
//
// Needs Node 18+ and NOTHING else - no npm packages, no database, no access
// to ALS's systems beyond the published public keys. Uses only node:crypto
// (plus node:fs to read the files, and the built-in fetch when --keys is a
// URL).
//
//   node verify-certificate.mjs --keys keys.json --certificate cert.json
//   node verify-certificate.mjs --keys https://<api>/verify/keys --certificate cert.json
//
//   keys.json         what GET /verify/keys returns:
//                     {"algorithm":"Ed25519","keys":[{"keyId","algorithm","publicKeyPem"}]}
//   cert.json         the signed certificate as data, as
//                     GET /assets/<id>/erasure-certificate.json returns it:
//                     {"id","number","assetId","issuedAt","payload",
//                      "payloadSha256","prevSha256","signature","keyId"}
//
// It checks that:
//   1. the payload, in canonical form, hashes to payloadSha256 (SHA-256);
//   2. the Ed25519 signature over the canonical payload verifies under the
//      published key named by keyId - and that keyId really is that key
//      (first 16 hex of SHA-256 over its DER encoding);
//   3. the id, number, asset, issued date, previous hash and key id outside
//      the payload are the ones inside it (so none was edited on its own).
// It cannot see the other certificates, so it does not walk the hash chain;
// GET /verify/<id> does that on the server.
//
// Exit status: 0 valid, 1 invalid, 2 usage or input error.
//
// THE CANONICAL FORM must match apps/api/src/certificates/canonical-json.ts
// exactly: object keys sorted (JavaScript's default string order), no
// whitespace, strings and numbers as JSON.stringify writes them, undefined
// keys dropped. certificate-signing.spec.ts runs this script against
// certificates the API issued, so the two cannot drift silently.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

function canonicalise(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(`cannot canonicalise the number ${value}`);
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((v) => {
            if (v === undefined)
              throw new TypeError('cannot canonicalise undefined in an array');
            return canonicalise(v);
          })
          .join(',')}]`;
      }
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort();
      return `{${keys
        .map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`)
        .join(',')}}`;
    }
    default:
      throw new TypeError(`cannot canonicalise a ${typeof value}`);
  }
}

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

function keyIdOf(publicKey) {
  return sha256Hex(publicKey.export({ type: 'spki', format: 'der' })).slice(
    0,
    16,
  );
}

// { valid: true } or { valid: false, reason }.
function verifyCertificate(cert, keysDoc) {
  if (!cert || typeof cert !== 'object' || !cert.payload)
    return { valid: false, reason: 'the certificate file has no payload' };
  const p = cert.payload;
  let bytes;
  try {
    bytes = Buffer.from(canonicalise(p), 'utf8');
  } catch (e) {
    return {
      valid: false,
      reason: `payload cannot be canonicalised: ${e.message}`,
    };
  }
  if (sha256Hex(bytes) !== cert.payloadSha256)
    return { valid: false, reason: 'the payload does not match its SHA-256' };
  const same = (a, b) => (a ?? null) === (b ?? null);
  if (
    !same(p.id, cert.id) ||
    !same(p.number, cert.number) ||
    !same(p.assetId, cert.assetId) ||
    !same(p.keyId, cert.keyId) ||
    !same(p.prevSha256, cert.prevSha256) ||
    new Date(p.issuedAt).getTime() !== new Date(cert.issuedAt).getTime()
  )
    return {
      valid: false,
      reason: 'the certificate details do not match its signed payload',
    };
  const entry = (keysDoc?.keys ?? []).find((k) => k.keyId === cert.keyId);
  if (!entry)
    return {
      valid: false,
      reason: `signing key ${cert.keyId} is not among the published keys`,
    };
  let key;
  try {
    key = createPublicKey(entry.publicKeyPem);
  } catch (e) {
    return {
      valid: false,
      reason: `published key is unreadable: ${e.message}`,
    };
  }
  if (key.asymmetricKeyType !== 'ed25519')
    return { valid: false, reason: 'published key is not an Ed25519 key' };
  if (keyIdOf(key) !== cert.keyId)
    return {
      valid: false,
      reason: 'the published key does not match its key id',
    };
  let ok = false;
  try {
    ok = verify(
      null,
      bytes,
      key,
      Buffer.from(String(cert.signature), 'base64'),
    );
  } catch {
    ok = false;
  }
  return ok
    ? { valid: true }
    : { valid: false, reason: 'the signature does not verify' };
}

async function readJson(source) {
  if (/^https?:/i.test(source)) {
    const res = await fetch(source, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const keysSrc = arg('--keys');
  const certSrc = arg('--certificate');
  if (!keysSrc || !certSrc) {
    console.error(
      'usage: node verify-certificate.mjs --keys <keys.json|URL> --certificate <certificate.json>',
    );
    return 2;
  }
  let keys, cert;
  try {
    [keys, cert] = await Promise.all([readJson(keysSrc), readJson(certSrc)]);
  } catch (e) {
    console.error(`cannot read input: ${e.message}`);
    return 2;
  }
  const v = verifyCertificate(cert, keys);
  if (v.valid) {
    console.log(
      `VALID - certificate ${cert.number} (id ${cert.id}), issued ${cert.issuedAt}, signed with key ${cert.keyId}`,
    );
    return 0;
  }
  console.log(`INVALID - ${v.reason}`);
  return 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
