import { MigrationInterface, QueryRunner } from 'typeorm';

// A cosmetic grade per pallet variant line, using the same A/B/C/D/for-parts/
// scrap scale as serialized assets. Additive & nullable.
export class AddPalletLineGrade1752300000000 implements MigrationInterface {
  name = 'AddPalletLineGrade1752300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "pallet_lines_grade_enum" AS ENUM ('grade_a', 'grade_b', 'grade_c', 'grade_d', 'for_parts', 'scrap')`,
    );
    await queryRunner.query(
      `ALTER TABLE "pallet_lines" ADD COLUMN IF NOT EXISTS "grade" "pallet_lines_grade_enum"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pallet_lines" DROP COLUMN IF EXISTS "grade"`);
    await queryRunner.query(`DROP TYPE "pallet_lines_grade_enum"`);
  }
}
