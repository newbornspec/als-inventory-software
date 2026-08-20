import { MigrationInterface, QueryRunner } from 'typeorm';

// The web app is not meant to take stock in for repair, so the repair work log
// goes — jobs, costs, the /repairs page, the dashboard tile, and repair spend
// feeding realised profit.
//
// What deliberately STAYS, because it is a different thing: the asset AUDIT
// verdicts `repair_required`, `ber` (beyond economic repair) and `refurbished`
// on assets_audit_status_enum, and `repair`/`parts` in FinalDisposition. Those
// are grading outcomes an ITAD audit still has to be able to record — and `ber`
// feeds the scrap counts on the lot page. Removing an enum value is also a
// one-way door in Postgres, so they are left alone.
//
// Safe to drop rather than archive: production held zero repair rows when this
// was written, checked against the live API, so nothing is being discarded.
// down() rebuilds the table exactly as 1752280000000 created it, so the
// migration is reversible even though the rows are not.
export class DropRepairLogs1752510000000 implements MigrationInterface {
  name = 'DropRepairLogs1752510000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The index goes with the table, but dropping it explicitly keeps this
    // readable as the exact inverse of the migration that created it.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_repair_logs_asset_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "repair_logs"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "repair_logs_status_enum"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "repair_logs_status_enum" AS ENUM ('pending', 'in_progress', 'completed', 'cannot_repair');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "repair_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "asset_id" uuid NOT NULL,
        "description" character varying NOT NULL,
        "parts_used" character varying,
        "cost" numeric(12,2),
        "status" "repair_logs_status_enum" NOT NULL DEFAULT 'pending',
        "performed_by_id" uuid,
        "completed_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_repair_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_repair_logs_asset" FOREIGN KEY ("asset_id")
          REFERENCES "assets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_repair_logs_user" FOREIGN KEY ("performed_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_repair_logs_asset_id" ON "repair_logs" ("asset_id")`,
    );
  }
}
