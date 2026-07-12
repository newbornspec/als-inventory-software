import { MigrationInterface, QueryRunner } from 'typeorm';

// Pallet improvements: an optional supplier + a shipped timestamp on the pallet,
// and an optional per-line unit cost. All nullable/additive — existing rows are
// untouched and every field stays optional so it never blocks saving.
export class AddPalletReporting1752260000000 implements MigrationInterface {
  name = 'AddPalletReporting1752260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pallets" ADD COLUMN IF NOT EXISTS "supplier" character varying`);
    await queryRunner.query(`ALTER TABLE "pallets" ADD COLUMN IF NOT EXISTS "shipped_at" TIMESTAMP`);
    await queryRunner.query(
      `ALTER TABLE "pallet_lines" ADD COLUMN IF NOT EXISTS "unit_cost" numeric(12,2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pallet_lines" DROP COLUMN IF EXISTS "unit_cost"`);
    await queryRunner.query(`ALTER TABLE "pallets" DROP COLUMN IF EXISTS "shipped_at"`);
    await queryRunner.query(`ALTER TABLE "pallets" DROP COLUMN IF EXISTS "supplier"`);
  }
}
