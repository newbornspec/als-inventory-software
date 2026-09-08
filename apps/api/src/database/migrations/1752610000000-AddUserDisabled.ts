import { MigrationInterface, QueryRunner } from 'typeorm';

// Disabling an account instead of deleting it.
//
// Deleting a user is lossy in a way that matters here: activity_log.user_id,
// asset_audits.audited_by_id, batches.owner_id and assets.sold_by_id all point
// at users, so removing the row turns "audited by Tim" into "audited by
// (nobody)". In an ITAD business that trail is the evidence, and a client
// asking who wiped a device six months ago deserves an answer. Disabling keeps
// every reference intact while stopping the person getting in.
//
// A nullable TIMESTAMP rather than a boolean, matching how this app records
// every other human state change — assets.sold_at + sold_by_id, and
// moved_to_pallet_at + moved_to_pallet_by_id. It answers "was this audit
// recorded before or after they left?" for free, which a boolean cannot.
// NULL means enabled, so every existing row is correct without a backfill.
export class AddUserDisabled1752610000000 implements MigrationInterface {
  name = 'AddUserDisabled1752610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "disabled_at" TIMESTAMP
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "disabled_by_id" uuid
    `);
    // SET NULL, not CASCADE: if the admin who disabled someone is themselves
    // later deleted, that must not delete the disabled account along with them.
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD CONSTRAINT "FK_users_disabled_by"
      FOREIGN KEY ("disabled_by_id") REFERENCES "users"("id") ON DELETE SET NULL
    `);
    // Partial: only disabled accounts carry a value, and "who is disabled" is
    // the only question anything asks of it.
    await queryRunner.query(`
      CREATE INDEX "IDX_users_disabled_at"
      ON "users" ("disabled_at")
      WHERE "disabled_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_disabled_at"`);
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "FK_users_disabled_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "disabled_by_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "disabled_at"
    `);
  }
}
