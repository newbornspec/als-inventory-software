import { MigrationInterface, QueryRunner } from 'typeorm';

// Splits the old single `status` enum (in_stock/assigned/in_repair/retired)
// into three independent concerns: stock_status (warehouse pipeline),
// condition_grade (cosmetic grade), and audit_status (functional testing
// outcome). "in_repair" didn't map to a clean single concept — it really
// meant "held back from stock (quarantined) because it needs repair" — so
// it splits into two fields on migration, which is exactly the bug this
// migration fixes.
export class SplitAssetStatus1752033600000 implements MigrationInterface {
  name = 'SplitAssetStatus1752033600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "assets_stock_status_enum" AS ENUM (
        'in_stock', 'out_of_stock', 'received', 'awaiting_audit', 'audited',
        'quarantined', 'allocated', 'picked', 'packed', 'shipped', 'returned', 'disposed'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "assets_condition_grade_enum" AS ENUM (
        'grade_a', 'grade_b', 'grade_c', 'grade_d', 'for_parts', 'scrap'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "assets_audit_status_enum" AS ENUM (
        'passed_testing', 'failed_testing', 'power_on', 'no_power', 'post_failed',
        'bios_locked', 'missing_components', 'data_wiped', 'data_wipe_failed',
        'refurbished', 'ready_for_sale', 'repair_required', 'ber'
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "assets" ADD COLUMN "stock_status" "assets_stock_status_enum"
    `);
    await queryRunner.query(`
      ALTER TABLE "assets" ADD COLUMN "condition_grade" "assets_condition_grade_enum"
    `);
    await queryRunner.query(`
      ALTER TABLE "assets" ADD COLUMN "audit_status" "assets_audit_status_enum"
    `);

    // Data-preserving mapping from the old 4-value enum.
    await queryRunner.query(`
      UPDATE "assets" SET "stock_status" = CASE "status"
        WHEN 'in_stock' THEN 'in_stock'
        WHEN 'assigned' THEN 'allocated'
        WHEN 'in_repair' THEN 'quarantined'
        WHEN 'retired' THEN 'disposed'
      END::"assets_stock_status_enum"
    `);
    await queryRunner.query(`
      UPDATE "assets" SET "audit_status" = 'repair_required'::"assets_audit_status_enum"
      WHERE "status" = 'in_repair'
    `);

    await queryRunner.query(`
      ALTER TABLE "assets" ALTER COLUMN "stock_status" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "assets" ALTER COLUMN "stock_status" SET DEFAULT 'received'
    `);

    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "status"`);
    await queryRunner.query(`DROP TYPE "assets_status_enum"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "assets_status_enum" AS ENUM ('in_stock', 'assigned', 'in_repair', 'retired')
    `);
    await queryRunner.query(`
      ALTER TABLE "assets" ADD COLUMN "status" "assets_status_enum"
    `);
    await queryRunner.query(`
      UPDATE "assets" SET "status" = CASE
        WHEN "audit_status" = 'repair_required' THEN 'in_repair'
        WHEN "stock_status" = 'disposed' THEN 'retired'
        WHEN "stock_status" = 'allocated' THEN 'assigned'
        ELSE 'in_stock'
      END::"assets_status_enum"
    `);
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" SET DEFAULT 'in_stock'`);

    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "stock_status"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "condition_grade"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "audit_status"`);
    await queryRunner.query(`DROP TYPE "assets_stock_status_enum"`);
    await queryRunner.query(`DROP TYPE "assets_condition_grade_enum"`);
    await queryRunner.query(`DROP TYPE "assets_audit_status_enum"`);
  }
}
