import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 4 — comprehensive hardware audit. The full auto-captured spec is stored
// as JSONB (extensible: new attributes need no migration). A few identity fields
// are promoted to real columns for search/filter. Warehouse fields are untouched.
export class AddHardwareProfile1752340000000 implements MigrationInterface {
  name = 'AddHardwareProfile1752340000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Current profile lives on the asset; every audit snapshots one too.
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "hardware_profile" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "serial_number" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "express_service_code" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "device_type" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "asset_audits" ADD COLUMN IF NOT EXISTS "hardware_profile" jsonb`,
    );

    // Search by serial / express service code from the global device register.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_assets_serial_number" ON "assets" ("serial_number")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_assets_express_service_code" ON "assets" ("express_service_code")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assets_express_service_code"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assets_serial_number"`);
    await queryRunner.query(`ALTER TABLE "asset_audits" DROP COLUMN IF EXISTS "hardware_profile"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "device_type"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "express_service_code"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "serial_number"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "hardware_profile"`);
  }
}
