import { MigrationInterface, QueryRunner } from 'typeorm';

// System-wide activity log (who did what, when). New table, no data change.
export class CreateActivityLog1752350000000 implements MigrationInterface {
  name = 'CreateActivityLog1752350000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "activity_log" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid,
        "action" character varying NOT NULL,
        "entity_type" character varying,
        "entity_id" uuid,
        "summary" text NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_activity_log" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_activity_log_user') THEN
          ALTER TABLE "activity_log" ADD CONSTRAINT "FK_activity_log_user"
            FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_activity_log_created_at" ON "activity_log" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "activity_log"`);
  }
}
