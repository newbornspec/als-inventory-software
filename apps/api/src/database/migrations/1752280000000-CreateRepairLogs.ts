import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 5a — repair/refurbishment work log per asset. New additive table;
// online-managed (not added to the powersync publication).
export class CreateRepairLogs1752280000000 implements MigrationInterface {
  name = 'CreateRepairLogs1752280000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "repair_logs_status_enum" AS ENUM ('pending', 'in_progress', 'completed', 'cannot_repair')`,
    );
    await queryRunner.query(`
      CREATE TABLE "repair_logs" (
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
      `CREATE INDEX "IDX_repair_logs_asset_id" ON "repair_logs" ("asset_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_repair_logs_asset_id"`);
    await queryRunner.query(`DROP TABLE "repair_logs"`);
    await queryRunner.query(`DROP TYPE "repair_logs_status_enum"`);
  }
}
