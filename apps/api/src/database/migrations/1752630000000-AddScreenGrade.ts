import { MigrationInterface, QueryRunner } from 'typeorm';

// A screen grade, separate from the cosmetic one.
//
// The audit station graded a unit once, and that single value was stored as
// cosmetic_grade. But a laptop with a scratched lid and a perfect panel is a
// different product from one with a pristine lid and a cracked screen, and
// resale price follows the screen far more closely than the casing. Grading
// them together loses the distinction at the point it is cheapest to record -
// with the machine open in front of the operator.
//
// Reuses "assets_condition_grade_enum", the type cosmetic_grade already uses
// (see 1752033700000-CreateAssetAudits). Same vocabulary, so the two grades are
// comparable and nothing new has to be kept in step.
//
// NULL means "not graded", which is every existing row and every desktop that
// has no screen to grade. The field is optional by design: the operator can
// leave it alone, and an audit is never blocked on it.
export class AddScreenGrade1752630000000 implements MigrationInterface {
  name = 'AddScreenGrade1752630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      ADD COLUMN IF NOT EXISTS "screen_grade" "assets_condition_grade_enum"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      DROP COLUMN IF EXISTS "screen_grade"
    `);
  }
}
