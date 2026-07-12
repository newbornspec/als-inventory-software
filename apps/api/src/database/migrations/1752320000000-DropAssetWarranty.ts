import { MigrationInterface, QueryRunner } from 'typeorm';

// Warranty tracking removed from the platform — it wasn't relevant to the ITAD
// resale workflow. Assets sync via `SELECT * FROM assets`, so dropping the
// column simply stops it syncing; no sync-rules change needed.
export class DropAssetWarranty1752320000000 implements MigrationInterface {
  name = 'DropAssetWarranty1752320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "warranty_expires_at"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assets" ADD COLUMN "warranty_expires_at" date`);
  }
}
