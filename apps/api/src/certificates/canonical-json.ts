// A small, deterministic JSON canonicaliser for signed erasure certificates
// (plan step 29).
//
// A signature is over BYTES, but a certificate is stored as jsonb, and jsonb
// keeps neither key order nor whitespace: what comes back out of Postgres is
// the same VALUE in a different spelling. So the bytes that are hashed and
// signed are never "whatever JSON.stringify happened to produce" - they are
// this canonical form, which anyone can rebuild from the value alone:
//   - object keys sorted by UTF-16 code unit (JavaScript's default sort, the
//     same order RFC 8785 uses), at every depth;
//   - no whitespace;
//   - strings and numbers written exactly as JSON.stringify writes them (for
//     the values stored here - strings, integers, booleans, null - that is
//     the same text RFC 8785 produces);
//   - keys whose value is undefined are dropped, as JSON.stringify drops them.
// Anything JSON cannot carry faithfully (NaN, Infinity, a bigint, a function,
// undefined inside an array) is REFUSED rather than silently turned into
// something else, because a value that changes on its way into the database
// would make a correct certificate fail verification forever.
//
// Written here rather than taken from the 'canonicalize' npm package that the
// remediation plan names: no new dependency (the offline verifier script,
// apps/api/scripts/verify-certificate.mjs, carries an identical copy so a
// customer can check a certificate with node:crypto alone). Keep the two in
// step - certificate-signing.spec.ts runs the script against certificates
// issued by this code.

export function canonicalise(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(`cannot canonicalise the number ${value}`);
      // -0 and 0 are the same JSON number.
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
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys
        .map((k) => `${JSON.stringify(k)}:${canonicalise(obj[k])}`)
        .join(',')}}`;
    }
    default:
      throw new TypeError(`cannot canonicalise a ${typeof value}`);
  }
}

// The value as it will come back out of jsonb: Dates become ISO strings (as
// JSON.stringify writes them), undefined keys disappear, and the one
// character jsonb cannot store at all - U+0000 - becomes U+FFFD, so a stray
// NUL in a drive's model string cannot make the insert fail. Hash and sign
// what this returns, and store exactly that. (fromCharCode, not an escape
// in a string literal: the escaped form has been mangled into a raw control
// character by tooling before.)
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

export function storable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_k, v: unknown) =>
    typeof v === 'string' ? v.split(NUL).join(REPLACEMENT) : v,
  ) as T;
}
