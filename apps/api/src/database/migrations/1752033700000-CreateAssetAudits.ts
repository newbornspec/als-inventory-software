import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAssetAudits1752033700000 implements MigrationInterface {
  name = 'CreateAssetAudits1752033700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "asset_audits_data_wipe_status_enum" AS ENUM ('not_started', 'wiped', 'failed')
    `);
    await queryRunner.query(`
      CREATE TYPE "asset_audits_final_disposition_enum" AS ENUM ('sell', 'repair', 'parts', 'recycle')
    `);

    await queryRunner.query(`
      CREATE TABLE "asset_audits" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "asset_id" uuid NOT NULL,
        "audit_status" "assets_audit_status_enum",
        "manufacturer" character varying,
        "model" character varying,
        "serial_number" character varying,
        "cpu" character varying,
        "ram_gb" integer,
        "storage_capacity" character varying,
        "screen_size" character varying,
        "screen_resolution" character varying,
        "battery_health" character varying,
        "cosmetic_grade" "assets_condition_grade_enum",
        "functional_tests" jsonb,
        "bios_locked" boolean,
        "charger_included" boolean,
        "data_wipe_status" "asset_audits_data_wipe_status_enum",
        "data_wipe_method" character varying,
        "final_disposition" "asset_audits_final_disposition_enum",
        "notes" character varying,
        "audited_by_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_asset_audits" PRIMARY KEY ("id"),
        CONSTRAINT "FK_asset_audits_asset" FOREIGN KEY ("asset_id")
          REFERENCES "assets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_asset_audits_audited_by" FOREIGN KEY ("audited_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_asset_audits_asset_id" ON "asset_audits" ("asset_id")`);

    // Extend the PowerSync publication so audit records replicate offline too —
    // recording an audit in the field (no signal) is exactly the offline-write
    // scenario /scan already handles for asset_history.
    await queryRunner.query(`ALTER PUBLICATION "powersync" ADD TABLE "asset_audits"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER PUBLICATION "powersync" DROP TABLE "asset_audits"`);
    await queryRunner.query(`DROP TABLE "asset_audits"`);
    await queryRunner.query(`DROP TYPE "asset_audits_data_wipe_status_enum"`);
    await queryRunner.query(`DROP TYPE "asset_audits_final_disposition_enum"`);
  }
}
