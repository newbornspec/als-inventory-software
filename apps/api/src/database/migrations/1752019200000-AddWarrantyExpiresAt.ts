import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWarrantyExpiresAt1752019200000 implements MigrationInterface {
  name = 'AddWarrantyExpiresAt1752019200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assets" ADD COLUMN "warranty_expires_at" DATE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "warranty_expires_at"`);
  }
}
