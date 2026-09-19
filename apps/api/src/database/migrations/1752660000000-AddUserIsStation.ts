import { MigrationInterface, QueryRunner } from 'typeorm';

// Marks the accounts that are SHARED, not a person (remediation plan step 28,
// stage 1).
//
// The audit station signs in as one account that every operator uses, so the
// account on a station wipe record is not the person who wiped the drive. The
// certificate already prints that account as "Filed by account" rather than
// "Performed by" (certificate-people.ts); what it could not do is tell a
// shared station login from a personal one. With this flag set by an admin,
// a wipe filed by a station account with no typed operator name says so on
// the certificate: "Operator: not recorded (shared station account)".
//
// Stage 1 only labels (owner decision D28). Stage 2 - refusing such wipes -
// waits until every stick in the field sends an operator, so that old sticks
// are not suddenly blocked.
//
// NOT NULL DEFAULT false: every existing account is a personal account until
// an admin says otherwise. On Postgres 11+ adding a column with a constant
// default is a catalogue-only change (no table rewrite), so the ACCESS
// EXCLUSIVE lock on users is momentary.
//
// ORDER: ships WITH the entity change and must run first - TypeORM selects
// every mapped column, so the new entity against the old table fails every
// users query (including login) with a 500. Railway runs migrations
// pre-deploy, which gives that order as long as both ship together.
//
// users is in the "powersync" publication with no column list, so the new
// column replicates to PowerSync; the sync rules select only id, name and
// role from users, so no client ever receives it.
export class AddUserIsStation1752660000000 implements MigrationInterface {
  name = 'AddUserIsStation1752660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "is_station" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "is_station"
    `);
  }
}
