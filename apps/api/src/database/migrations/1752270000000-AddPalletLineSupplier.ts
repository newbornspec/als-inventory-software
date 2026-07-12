import { MigrationInterface, QueryRunner } from 'typeorm';

// A single pallet can hold mixed stock from multiple suppliers, so supplier is a
// per-line attribute. The pallet-level supplier stays as an optional default.
export class AddPalletLineSupplier1752270000000 implements MigrationInterface {
  name = 'AddPalletLineSupplier1752270000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pallet_lines" ADD COLUMN IF NOT EXISTS "supplier" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pallet_lines" DROP COLUMN IF EXISTS "supplier"`);
  }
}
