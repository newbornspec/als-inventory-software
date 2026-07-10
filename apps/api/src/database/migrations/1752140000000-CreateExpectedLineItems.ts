import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 1.3 — the supplier manifest as "expected inventory" for a purchase lot.
// Additive: a brand-new table, and deliberately NOT added to the "powersync"
// publication (it's REST-only until receiving verification needs it offline in
// a later phase), so it cannot affect any existing row, query, or synced client.
export class CreateExpectedLineItems1752140000000 implements MigrationInterface {
  name = 'CreateExpectedLineItems1752140000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "expected_line_items_verification_status_enum"
        AS ENUM ('pending', 'found', 'missing', 'mismatch', 'extra')
    `);
    await queryRunner.query(`
      CREATE TABLE "expected_line_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "batch_id" uuid NOT NULL,
        "asset_tag" character varying,
        "serial_number" character varying,
        "manufacturer" character varying,
        "model" character varying,
        "cpu" character varying,
        "ram_gb" integer,
        "storage" character varying,
        "screen_size" character varying,
        "condition" character varying,
        "grade" character varying,
        "quantity" integer NOT NULL DEFAULT 1,
        "verification_status" "expected_line_items_verification_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_expected_line_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_expected_line_items_batch" FOREIGN KEY ("batch_id")
          REFERENCES "batches"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_expected_line_items_batch_id" ON "expected_line_items" ("batch_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_expected_line_items_batch_id"`);
    await queryRunner.query(`DROP TABLE "expected_line_items"`);
    await queryRunner.query(`DROP TYPE "expected_line_items_verification_status_enum"`);
  }
}
