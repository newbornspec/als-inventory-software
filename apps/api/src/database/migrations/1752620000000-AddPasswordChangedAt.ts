import { MigrationInterface, QueryRunner } from 'typeorm';

// Makes a password reset actually end the old sessions.
//
// Access tokens are unrevocable and live 12h (config/configuration.ts), so an
// admin resetting a compromised account's password would change the password
// and leave the attacker's existing session working until tonight — while
// believing they had just locked them out. Every system people use behaves the
// opposite way, so the assumption is reasonable and the gap is a real one.
//
// The fix needs no new token shape (the JWT is a contract with PowerSync — see
// auth.service.ts issueTokens): JWTs already carry `iat`, so a token issued
// BEFORE this timestamp is stale and gets rejected. Read through the same
// PermissionsService snapshot that carries role, grants and disabled_at, so it
// costs a cache hit rather than a query.
//
// NULL means "never reset", which is every existing row — no backfill, and no
// token is invalidated by deploying this.
export class AddPasswordChangedAt1752620000000 implements MigrationInterface {
  name = 'AddPasswordChangedAt1752620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMP
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "password_changed_at"
    `);
  }
}
