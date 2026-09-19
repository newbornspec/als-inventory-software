import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CertificateLedger } from './certificate-ledger';
import { CertificateSigner } from './certificate-signing';

// Signed, stored erasure certificates (plan step 29). One ledger for the
// whole API, shared by the station ingest (issues when a machine becomes
// certifiable) and the certificate download (issues if missing, then draws
// from the stored snapshot). The signer is read from CERT_SIGNING_KEY once,
// at startup: unset -> null -> everything inert; set but unusable -> the API
// refuses to start (see certificate-signing.ts).
@Module({
  providers: [
    {
      provide: CertificateLedger,
      inject: [DataSource],
      useFactory: (ds: DataSource) =>
        new CertificateLedger(ds, CertificateSigner.fromEnv()),
    },
  ],
  exports: [CertificateLedger],
})
export class ErasureCertificatesModule {}
