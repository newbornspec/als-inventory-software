import { MigrationInterface, QueryRunner } from 'typeorm';

// "Expected today / Expected this week / Overdue" on the dashboard needs a date
// the goods are DUE, and the batches table had no such column. It has
// purchase_date (when we bought it) and received_date (when it landed) — using
// either as a stand-in would report a lot bought in January as three months
// overdue, which is not the same fact at all.
//
// Nullable on purpose: most lots are created as the pallet is being unloaded,
// so there is nothing to promise. A lot with no expected date is counted as
// "awaiting receipt" only, and can never be overdue.
export class AddBatchExpectedArrival1752500000000 implements MigrationInterface {
  name = 'AddBatchExpectedArrival1752500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "expected_arrival_date" date`,
    );
    // Every dashboard incoming query filters on this date and on status, and
    // the rows that matter are the few not yet received — a partial index keeps
    // it small as received history grows.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_batches_expected_arrival"
        ON "batches" ("expected_arrival_date")
        WHERE "expected_arrival_date" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_batches_expected_arrival"`);
    await queryRunner.query(
      `ALTER TABLE "batches" DROP COLUMN IF EXISTS "expected_arrival_date"`,
    );
  }
}
