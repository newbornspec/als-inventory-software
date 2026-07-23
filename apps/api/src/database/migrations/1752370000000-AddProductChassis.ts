import { MigrationInterface, QueryRunner } from 'typeorm';

// Chassis/form-factor as a first-class product column (Layout 2 treats it as its
// own field). Additive & nullable.
export class AddProductChassis1752370000000 implements MigrationInterface {
  name = 'AddProductChassis1752370000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "chassis" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "chassis"`);
  }
}
