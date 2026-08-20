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
    //
    // Guarded because hardware_profile is CREATED by a later migration
    // (1752340000000-AddHardwareProfile) — this one only ever saw the column
    // because it already existed from synchronize:true before migrations were
    // adopted. Unguarded, the chain cannot rebuild the database from scratch:
    // every fresh environment — a new staging database, a restore from backup,
    // a new developer — dies here with 'column "hardware_profile" does not
    // exist'. On any database where this migration has already run it is
    // recorded and never runs again, so this changes nothing that exists today.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'assets' AND column_name = 'hardware_profile'
        ) THEN
          UPDATE "assets"
             SET "manufacturer" = NULLIF(TRIM("hardware_profile"->'identification'->>'manufacturer'), ''),
                 "model"        = NULLIF(TRIM("hardware_profile"->'identification'->>'model'), '')
           WHERE "hardware_profile" IS NOT NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "model"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "manufacturer"`);
  }
}
