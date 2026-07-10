import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 1.1 — let a purchase lot (the `batches` table) exist BEFORE goods
// arrive. Additive: new nullable columns + two new lifecycle states. Supplier
// reuses the existing `source` column (relabelled "Supplier" in the UI).
//
// Note: PostgreSQL cannot drop enum values, so down() only removes the columns;
// 'draft'/'awaiting_arrival' remain on the type (harmless). ADD VALUE runs fine
// inside the migration transaction on PG16 as long as the value isn't used in
// the same transaction — it isn't.
export class AddPurchaseLotPreArrivalFields1752130000000 implements MigrationInterface {
  name = 'AddPurchaseLotPreArrivalFields1752130000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "batches" ADD COLUMN "purchase_order" character varying`);
    await queryRunner.query(`ALTER TABLE "batches" ADD COLUMN "delivery_note" character varying`);
    await queryRunner.query(`ALTER TABLE "batches" ADD COLUMN "purchase_date" date`);

    await queryRunner.query(`ALTER TYPE "batches_status_enum" ADD VALUE IF NOT EXISTS 'draft'`);
    await queryRunner.query(
      `ALTER TYPE "batches_status_enum" ADD VALUE IF NOT EXISTS 'awaiting_arrival'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "batches" DROP COLUMN "purchase_date"`);
    await queryRunner.query(`ALTER TABLE "batches" DROP COLUMN "delivery_note"`);
    await queryRunner.query(`ALTER TABLE "batches" DROP COLUMN "purchase_order"`);
    // enum values 'draft' / 'awaiting_arrival' intentionally left in place —
    // PostgreSQL has no ALTER TYPE ... DROP VALUE.
  }
}
