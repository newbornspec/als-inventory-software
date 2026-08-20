import { MigrationInterface, QueryRunner } from 'typeorm';

// Merging two or more pallets onto a new one. Additive throughout: no pallet
// has ever been merged, so there is nothing to backfill.
//
// The design that drives this schema: a merge MOVES lines to the new pallet
// rather than copying them. A pallet_lines row is a claim on physical stock,
// and every consumer sums the table with no status filter — so a copied line
// would be sellable, invoiceable and countable twice, forever. Moving keeps
// SUM(quantity) globally identical and needs no defensive edits anywhere.
//
// Two records, answering two different questions:
//   pallet_lines.source_pallet_id  — where THIS item came from (per row).
//   pallet_merges                  — the merge EVENT (per source, per merge).
// Neither alone is enough. Derive "Created from: PALLET-a, PALLET-b" from the
// lines and it disappears the moment the last line from PALLET-a is sold off
// the merged pallet — a pallet would forget its own parentage as a side effect
// of normal trading. A merge is an event; it is recorded as one.
//
// Note: PostgreSQL cannot drop enum values, so down() leaves 'merged' on the
// type (harmless) but MUST reset any row still using it — see below.
export class AddPalletMerge1752540000000 implements MigrationInterface {
  name = 'AddPalletMerge1752540000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Terminal status, reachable only by merging. ADD VALUE runs fine inside
    // the migration transaction on PG16 as long as the value isn't USED in the
    // same transaction — it isn't; only application code writes it, later.
    await queryRunner.query(
      `ALTER TYPE "pallets_status_enum" ADD VALUE IF NOT EXISTS 'merged'`,
    );

    await queryRunner.query(
      `ALTER TABLE "pallet_lines" ADD COLUMN IF NOT EXISTS "source_pallet_id" uuid`,
    );
    // A snapshot beside the FK, the same idiom as pallet_sold_lines.pallet_number:
    // the FK is SET NULL, so the readable label has to survive the null.
    await queryRunner.query(
      `ALTER TABLE "pallet_lines" ADD COLUMN IF NOT EXISTS "source_pallet_number" character varying`,
    );

    // SET NULL, emphatically NOT CASCADE. pallet_lines.pallet_id IS cascade —
    // copying that here would mean deleting a merged-away original deletes the
    // SURVIVING pallet's stock.
    await queryRunner.query(`
      ALTER TABLE "pallet_lines"
      ADD CONSTRAINT "FK_pallet_lines_source_pallet"
      FOREIGN KEY ("source_pallet_id") REFERENCES "pallets"("id") ON DELETE SET NULL
    `);
    // This index IS the original pallet's "contents at merge" page.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_pallet_lines_source_pallet_id" ON "pallet_lines" ("source_pallet_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "pallet_merges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "result_pallet_id" uuid NOT NULL,
        "source_pallet_id" uuid,
        "source_pallet_number" character varying NOT NULL,
        "units_contributed" integer NOT NULL DEFAULT 0,
        "lines_contributed" integer NOT NULL DEFAULT 0,
        "merged_by_id" uuid,
        "merged_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_pallet_merges" PRIMARY KEY ("id"),
        CONSTRAINT "FK_pallet_merges_result" FOREIGN KEY ("result_pallet_id")
          REFERENCES "pallets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_pallet_merges_source" FOREIGN KEY ("source_pallet_id")
          REFERENCES "pallets"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_pallet_merges_user" FOREIGN KEY ("merged_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_pallet_merges_result" ON "pallet_merges" ("result_pallet_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_pallet_merges_source" ON "pallet_merges" ("source_pallet_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reset merged shells FIRST. 'merged' cannot be removed from the enum, but
    // a row left at 'merged' breaks the reverted code outright: the TS enum
    // would not contain it, so UpdatePalletDto's @IsEnum would reject every
    // PATCH to that pallet — a silently unpatchable record.
    //
    // Stated plainly: after a rollback those shells reappear as 0-unit Ready
    // pallets, and their stock stays on the merged pallet. That is acceptable
    // for a rollback; unpatchable pallets are not.
    await queryRunner.query(
      `UPDATE "pallets" SET "status" = 'ready' WHERE "status" = 'merged'`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pallet_merges_source"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pallet_merges_result"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "pallet_merges"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pallet_lines_source_pallet_id"`);
    await queryRunner.query(
      `ALTER TABLE "pallet_lines" DROP CONSTRAINT IF EXISTS "FK_pallet_lines_source_pallet"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pallet_lines" DROP COLUMN IF EXISTS "source_pallet_number"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pallet_lines" DROP COLUMN IF EXISTS "source_pallet_id"`,
    );
    // 'merged' intentionally left on pallets_status_enum — PostgreSQL has no
    // ALTER TYPE ... DROP VALUE.
  }
}
