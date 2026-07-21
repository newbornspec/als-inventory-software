import { MigrationInterface, QueryRunner } from 'typeorm';

// One buyer per pallet (who the whole pallet is being sold to), shown at the top
// beside the supplier. Additive & nullable. The earlier per-line buyer is
// dropped from the UI/API; its old physical column ("pallet_lines"."supplier")
// is simply left unused — no destructive change.
export class AddPalletBuyer1752320000000 implements MigrationInterface {
  name = 'AddPalletBuyer1752320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pallets" ADD COLUMN IF NOT EXISTS "buyer" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pallets" DROP COLUMN IF EXISTS "buyer"`);
  }
}
