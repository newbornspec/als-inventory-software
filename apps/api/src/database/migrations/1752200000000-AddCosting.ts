import { MigrationInterface, QueryRunner } from 'typeorm';

// Cost basis for profit tracking (D6): what the whole purchase lot cost, plus
// an optional manual per-unit override. Both nullable and additive — existing
// rows are untouched and cost is simply "unknown" until entered.
export class AddCosting1752200000000 implements MigrationInterface {
  name = 'AddCosting1752200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "total_cost" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "purchase_cost" numeric(12,2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "purchase_cost"`);
    await queryRunner.query(`ALTER TABLE "batches" DROP COLUMN IF EXISTS "total_cost"`);
  }
}
