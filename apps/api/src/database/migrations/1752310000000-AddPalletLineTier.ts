import { MigrationInterface, QueryRunner } from 'typeorm';

// A sale tier per pallet variant line (e.g. "tier_1", "tier_2"). Free-text so
// new tiers never need a schema change. Additive & nullable — existing lines
// keep NULL ("none"). The line's buyer keeps its legacy column name "supplier"
// in the database; only the application-facing name changed to "buyer".
export class AddPalletLineTier1752310000000 implements MigrationInterface {
  name = 'AddPalletLineTier1752310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pallet_lines" ADD COLUMN IF NOT EXISTS "tier" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pallet_lines" DROP COLUMN IF EXISTS "tier"`);
  }
}
