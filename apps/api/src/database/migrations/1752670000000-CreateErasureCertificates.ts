import { MigrationInterface, QueryRunner } from 'typeorm';

// Stored, signed, tamper-evident erasure certificates (remediation plan step
// 29, owner decision D29).
//
// Until now a certificate was rebuilt from editable rows on every download,
// dated "now", with a number derived on the fly and no signature: two
// downloads a month apart could say different things, and nothing showed
// whether a row had been edited in between. From here, once CERT_SIGNING_KEY
// is set, the API issues each certificate ONCE into this table - a snapshot
// of exactly what the PDF says, hashed, chained to the certificate before it
// and signed - and every download draws the PDF from that snapshot.
//
// INSERT-ONLY. A trigger rejects UPDATE and DELETE on every row, and a
// statement trigger rejects TRUNCATE (which skips row triggers). A re-wipe
// issues a NEW certificate; nothing ever edits or removes an old one. Getting
// past this needs the table owner to disable the trigger - and the hash chain
// (prev_sha256) then shows it: changing one certificate breaks verification
// of that certificate and of every one issued after it.
//
//   seq            issue order (identity); the chain head is the highest.
//   payload_sha256 UNIQUE: two certificates cannot hash alike.
//   prev_sha256    UNIQUE: two certificates cannot claim the same
//                  predecessor, so the chain cannot fork; and at most ONE row
//                  may have no predecessor (the partial unique index), so it
//                  cannot restart either.
//   asset_id       indexed for "this asset's latest certificate". No foreign
//                  key: a certificate outlives the asset row, and an FK action
//                  (CASCADE / SET NULL) would be an UPDATE or DELETE the
//                  trigger refuses, failing the asset's deletion.
//
// NOT in the "powersync" publication (1751990400000-InitSchema lists its
// tables explicitly, and nothing here adds this one) and not in
// powersync/sync-rules.yaml: nothing offline reads certificates, and the
// payload carries drive serials and names.
//
// New table, so no lock on anything that serves traffic. Ships with the code
// that maps it (Railway runs migrations pre-deploy); with CERT_SIGNING_KEY
// unset the code never touches it.
export class CreateErasureCertificates1752670000000 implements MigrationInterface {
  name = 'CreateErasureCertificates1752670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "erasure_certificates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "seq" bigint GENERATED ALWAYS AS IDENTITY,
        "number" text NOT NULL,
        "asset_id" uuid NOT NULL,
        "payload" jsonb NOT NULL,
        "payload_sha256" char(64) NOT NULL,
        "prev_sha256" char(64),
        "signature" text NOT NULL,
        "key_id" varchar(16) NOT NULL,
        "issued_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_erasure_certificates" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_erasure_certificates_seq" UNIQUE ("seq"),
        CONSTRAINT "UQ_erasure_certificates_number" UNIQUE ("number"),
        CONSTRAINT "UQ_erasure_certificates_sha256" UNIQUE ("payload_sha256"),
        CONSTRAINT "UQ_erasure_certificates_prev" UNIQUE ("prev_sha256")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_erasure_certificates_one_start"
      ON "erasure_certificates" ((true))
      WHERE "prev_sha256" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_erasure_certificates_asset"
      ON "erasure_certificates" ("asset_id", "seq")
    `);
    await queryRunner.query(`
      CREATE FUNCTION "erasure_certificates_insert_only"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'erasure_certificates is insert-only: % is not allowed (issue a new certificate instead)', TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "erasure_certificates_no_update_delete"
      BEFORE UPDATE OR DELETE ON "erasure_certificates"
      FOR EACH ROW EXECUTE FUNCTION "erasure_certificates_insert_only"()
    `);
    await queryRunner.query(`
      CREATE TRIGGER "erasure_certificates_no_truncate"
      BEFORE TRUNCATE ON "erasure_certificates"
      FOR EACH STATEMENT EXECUTE FUNCTION "erasure_certificates_insert_only"()
    `);
  }

  // Dropping the table is the only way to remove issued certificates, and it
  // is deliberately possible only by reverting this migration.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "erasure_certificates"`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "erasure_certificates_insert_only"()`,
    );
  }
}
