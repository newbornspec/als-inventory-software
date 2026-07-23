import { MigrationInterface, QueryRunner } from 'typeorm';

// Batch ownership foundation (traceability phase — no access enforcement yet).
// Adds an explicit owner + created_by to each batch, distinct from received_by.
// Backfills existing batches: owner -> the admin account (admin@als.com, or the
// oldest admin, or any user as a last resort); created_by -> the recorded
// receiver where known, else the same owner. Additive & nullable.
export class AddBatchOwnership1752340000000 implements MigrationInterface {
  name = 'AddBatchOwnership1752340000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "owner_id" uuid`);
    await queryRunner.query(`ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "created_by_id" uuid`);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_batches_owner') THEN
          ALTER TABLE "batches" ADD CONSTRAINT "FK_batches_owner"
            FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_batches_created_by') THEN
          ALTER TABLE "batches" ADD CONSTRAINT "FK_batches_created_by"
            FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // Owner -> admin (per the chosen backfill). Robust to differing seed data.
    await queryRunner.query(`
      UPDATE "batches" SET "owner_id" = COALESCE(
        (SELECT id FROM "users" WHERE email = 'admin@als.com' LIMIT 1),
        (SELECT id FROM "users" WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1),
        (SELECT id FROM "users" ORDER BY created_at ASC LIMIT 1)
      )
      WHERE "owner_id" IS NULL
    `);

    // Created-by -> the recorded receiver where we have it, else the owner.
    await queryRunner.query(`
      UPDATE "batches" SET "created_by_id" = COALESCE("received_by_id", "owner_id")
      WHERE "created_by_id" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "batches" DROP CONSTRAINT IF EXISTS "FK_batches_created_by"`,
    );
    await queryRunner.query(`ALTER TABLE "batches" DROP CONSTRAINT IF EXISTS "FK_batches_owner"`);
    await queryRunner.query(`ALTER TABLE "batches" DROP COLUMN IF EXISTS "created_by_id"`);
    await queryRunner.query(`ALTER TABLE "batches" DROP COLUMN IF EXISTS "owner_id"`);
  }
}
