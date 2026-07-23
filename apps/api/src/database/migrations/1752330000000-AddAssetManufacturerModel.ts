import { MigrationInterface, QueryRunner } from 'typeorm';

// Promote manufacturer + model out of the hardware_profile JSONB into indexed
// asset columns, so batch-scoped asset tables can show them without loading the
// full profile blob per row (same pattern as serial_number / device_type).
// Additive & nullable; backfilled from existing audits' identification.
export class AddAssetManufacturerModel1752330000000 implements MigrationInterface {
  name = 'AddAssetManufacturerModel1752330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "manufacturer" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "model" character varying`,
    );
    // Backfill from the captured profile (select:false column, still queryable).
    await queryRunner.query(`
      UPDATE "assets"
         SET "manufacturer" = NULLIF(TRIM("hardware_profile"->'identification'->>'manufacturer'), ''),
             "model"        = NULLIF(TRIM("hardware_profile"->'identification'->>'model'), '')
       WHERE "hardware_profile" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "model"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "manufacturer"`);
  }
}
