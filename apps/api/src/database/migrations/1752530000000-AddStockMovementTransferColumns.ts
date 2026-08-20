import { MigrationInterface, QueryRunner } from 'typeorm';

// A consumable transfer is TWO movement rows — -n leaving one line, +n arriving
// at another. Without these columns the only thing joining them is prose in the
// note field and a shared timestamp, which fails in three ways:
//
//   * nothing links the halves, so "show me that move" means string-matching;
//   * a note freezes the location NAME, so renaming a location makes history
//     lie about where stock went;
//   * a correction or reversal is indistinguishable from a fresh move.
//
// It is tempting to derive from/to from each line's current location_id
// instead. That is unsafe: StockService.update accepts locationId and will move
// a whole line — quantity and entire movement history — to another location
// without writing any movement at all. A line's present location is therefore
// not evidence of where a past movement happened.
//
// All three are nullable and stay null on the five non-transfer reasons and on
// every historical row, so this is purely additive.
export class AddStockMovementTransferColumns1752530000000 implements MigrationInterface {
  name = 'AddStockMovementTransferColumns1752530000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "stock_movements"
        ADD COLUMN IF NOT EXISTS "transfer_id" uuid,
        ADD COLUMN IF NOT EXISTS "from_location_id" uuid,
        ADD COLUMN IF NOT EXISTS "to_location_id" uuid
    `);

    // SET NULL rather than CASCADE: deleting a location must never delete the
    // record that stock once moved out of it.
    await queryRunner.query(`
      ALTER TABLE "stock_movements"
        ADD CONSTRAINT "FK_stock_movements_from_location"
        FOREIGN KEY ("from_location_id") REFERENCES "locations"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "stock_movements"
        ADD CONSTRAINT "FK_stock_movements_to_location"
        FOREIGN KEY ("to_location_id") REFERENCES "locations"("id") ON DELETE SET NULL
    `);

    // Partial: only transfer rows carry one, and they are the only rows anyone
    // looks up this way.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_movements_transfer_id"
        ON "stock_movements" ("transfer_id")
        WHERE "transfer_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_stock_movements_transfer_id"`);
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "FK_stock_movements_to_location"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "FK_stock_movements_from_location"`,
    );
    await queryRunner.query(`
      ALTER TABLE "stock_movements"
        DROP COLUMN IF EXISTS "to_location_id",
        DROP COLUMN IF EXISTS "from_location_id",
        DROP COLUMN IF EXISTS "transfer_id"
    `);
  }
}
