import { randomUUID } from 'node:crypto';
import { storable } from './canonical-json';
import {
  canonicalBytes,
  sha256Hex,
  type CertificatePayload,
  type CertificateRecord,
  type CertificateSigner,
} from './certificate-signing';

// n signed certificates chained onto `prevSha256`, built the way the ledger
// builds them - for specs that need a LONG chain without filing n wipes.
// Not a spec itself (jest runs only *.spec.ts); the name ends in "spec.ts" so
// tsconfig.build.json keeps it out of dist.
export function signedLinks(
  signer: CertificateSigner,
  n: number,
  prevSha256: string | null,
): CertificateRecord[] {
  const out: CertificateRecord[] = [];
  let prev = prevSha256;
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    const payload = storable<CertificatePayload>({
      v: 1,
      id,
      number: `ERA-FIXTURE-${id.slice(0, 13).toUpperCase()}`,
      assetId: randomUUID(),
      issuedAt: new Date(Date.UTC(2026, 8, 19, 10, 0, i)).toISOString(),
      prevSha256: prev,
      keyId: signer.keyId,
      sources: [`fixture|${i}`],
      certificate: {
        certNo: id,
        intro: 'Fixture',
        device: [['Model', 'Latitude 7490']],
        erasure: [],
        drives: [],
        notices: [],
        extra: [],
        footer: '',
      } as unknown as CertificatePayload['certificate'],
      summary: {
        make: 'Dell',
        model: 'Latitude 7490',
        driveCount: 1,
        sanitisationLevel: 'purge',
      },
    });
    const bytes = canonicalBytes(payload);
    const rec: CertificateRecord = {
      id,
      number: payload.number,
      assetId: payload.assetId,
      issuedAt: new Date(payload.issuedAt),
      payload,
      payloadSha256: sha256Hex(bytes),
      prevSha256: prev,
      signature: signer.sign(bytes),
      keyId: signer.keyId,
    };
    out.push(rec);
    prev = rec.payloadSha256;
  }
  return out;
}
