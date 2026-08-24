import { MigrationInterface, QueryRunner } from 'typeorm';

// Which pallet a device was sold FROM.
//
// pallet_id is the live ALLOCATION marker and has to be cleared when a device
// sells off an open pallet — otherwise that pallet keeps claiming stock that
// has gone, and its unit count (a live COUNT over assets.pallet_id) inflates
// the inventory totals. Clearing it, though, destroyed the only record of
// where the device sat, so "which pallet did this sell from?" became
// unanswerable on the register.
//
// This column answers it without touching allocation: it is history, never a
// claim on stock. Nothing counts it, so no total can move because of it.
export class AddSoldFromPallet1752600000000 implements MigrationInterface {
  name = 'AddSoldFromPallet1752600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assets"
      ADD COLUMN IF NOT EXISTS "sold_from_pallet_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "assets"
      ADD CONSTRAINT "FK_assets_sold_from_pallet"
      FOREIGN KEY ("sold_from_pallet_id") REFERENCES "pallets"("id") ON DELETE SET NULL
    `);
    // Partial index: only sold devices ever carry a value, and that is the
    // only population the register filters or joins on.
    await queryRunner.query(`
      CREATE INDEX "IDX_assets_sold_from_pallet"
      ON "assets" ("sold_from_pallet_id")
      WHERE "sold_from_pallet_id" IS NOT NULL
    `);

    // --- Backfill 1: devices sold WITH their pallet -------------------------
    // A whole-pallet sale keeps pallet_id as the shipped manifest, so the
    // answer is already on the row. Exact, no inference.
    //
    // ::text on every enum comparison below is load-bearing, not style.
    // TypeORM runs the whole migration chain in ONE transaction, so on a FRESH
    // database the 'sold' label was added by an earlier migration in this same
    // transaction and Postgres refuses to compare against it (55P04, "new enum
    // values must be committed before they can be used"). Comparing as text
    // sidesteps that. Without it this passes on the long-lived production
    // database and kills every newly created one.
    await queryRunner.query(`
      UPDATE "assets"
      SET "sold_from_pallet_id" = "pallet_id"
      WHERE "stock_status"::text = 'sold'
        AND "pallet_id" IS NOT NULL
        AND "sold_from_pallet_id" IS NULL
    `);

    // --- Backfill 2: devices sold INDIVIDUALLY off a pallet -----------------
    // Their pallet_id was cleared at sale time, but the allocation trail
    // survives in asset_history: this app writes 'Moved to PALLET-x' when a
    // device joins a pallet and 'Removed from PALLET-x ...' when it leaves.
    // Take each sold device's most recent ALLOCATED event and use it ONLY if
    // it was a join — if the device's last allocation event was a removal it
    // was not on a pallet when it sold, and inferring one would be a lie.
    await queryRunner.query(`
      WITH last_alloc AS (
        SELECT DISTINCT ON (h."asset_id")
               h."asset_id",
               h."notes"
        FROM "asset_history" h
        WHERE h."event_type"::text = 'allocated'
          AND h."notes" IS NOT NULL
        ORDER BY h."asset_id", h."created_at" DESC, h."id" DESC
      )
      UPDATE "assets" a
      SET "sold_from_pallet_id" = p."id"
      FROM last_alloc l
      JOIN "pallets" p
        ON p."pallet_number" = substring(l."notes" from 'PALLET-[0-9]+')
      WHERE a."id" = l."asset_id"
        AND a."stock_status"::text = 'sold'
        AND a."sold_from_pallet_id" IS NULL
        AND l."notes" LIKE 'Moved to PALLET-%'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assets_sold_from_pallet"`);
    await queryRunner.query(`
      ALTER TABLE "assets" DROP CONSTRAINT IF EXISTS "FK_assets_sold_from_pallet"
    `);
    await queryRunner.query(`
      ALTER TABLE "assets" DROP COLUMN IF EXISTS "sold_from_pallet_id"
    `);
  }
}
