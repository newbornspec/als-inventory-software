import { MigrationInterface, QueryRunner } from 'typeorm';

// Selling can now capture money: an optional per-unit sale price on assets,
// and on pallet sold rows the total sale amount plus a snapshot of the line's
// unit cost at the moment of sale (so profit stays computable even after the
// source line is gone). All additive/nullable — the one-click flow still works
// without entering a price.
export class AddSalePrices1752420000000 implements MigrationInterface {
  name = 'AddSalePrices1752420000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "sale_price" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "pallet_sold_lines" ADD COLUMN IF NOT EXISTS "sale_total" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "pallet_sold_lines" ADD COLUMN IF NOT EXISTS "unit_cost" numeric(12,2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pallet_sold_lines" DROP COLUMN IF EXISTS "unit_cost"`);
    await queryRunner.query(`ALTER TABLE "pallet_sold_lines" DROP COLUMN IF EXISTS "sale_total"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "sale_price"`);
  }
}
