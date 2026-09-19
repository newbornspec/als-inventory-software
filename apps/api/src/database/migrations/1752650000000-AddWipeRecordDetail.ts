import { MigrationInterface, QueryRunner } from 'typeorm';

// What a wipe record needs to say, beyond "wiped" and a method label
// (remediation spec steps 19, 26 and 39 - storage only; printing these on the
// certificate is a later step).
//
//   wiped_at, wipe_started_at  when the drive was actually erased, by the
//                              station's clock. created_at is when the record
//                              reached the server - hours or days later for a
//                              record that was queued offline.
//   wiped_at_clock             'network' | 'unsynced': was that clock synced.
//   wiped_drive_serial         WHICH drive. The station files one record per
//   wiped_drive                drive; without the serial nothing can tell two
//                              drives of one machine from one drive wiped
//                              twice. The serial gets its own indexed column
//                              for per-drive lookups; the rest of the drive's
//                              identity (model, size, transport, wwn, path)
//                              is jsonb.
//   tool_name/_version/_commit which code produced the record.
//   wipe_method_requested/     what was asked for, what was tried in order,
//   wipe_method_attempted/     and why a stronger method was not used.
//   wipe_fallback_reason
//   sanitisation_level         'purge' | 'clear' | 'none' (NIST SP 800-88).
//                              CHECKed: the certificate will key its wording
//                              off this, so a stray value must not get in.
//   wipe_verification          read-back result: clean | found | unverified.
//   hidden_areas               HPA/DCO outcome.
//   lock_status                the device-lock roll-up (CLEAR | LOCKED |
//                              WARNING | UNVERIFIED), derived by the SERVER
//                              from the hardware profile, so old sticks get
//                              it too.
//   wipe_limitations, wipe_smart  free-text limitations and SMART counters.
//
// Every column is NULLABLE, forever: old sticks keep sending old payloads for
// months, and an old payload must keep filing. varchar rather than Postgres
// enums (except the one CHECK), for the same reason as audit_kind: the ingest
// normalises unknown values to NULL with a note instead of rejecting them,
// because a 400 makes a stick retry the upload forever.
//
// ORDER - this migration MUST be applied before the code that maps these
// columns serves traffic. TypeORM selects every mapped column, so the new
// entity against the old table fails every asset_audits query with a 500.
// Railway runs migrations pre-deploy, which gives that order as long as the
// migration and the entity change ship together.
//
// LOCKING. TypeORM runs the whole chain in ONE transaction, and ADD COLUMN
// takes an ACCESS EXCLUSIVE lock on asset_audits that is held until it
// commits - while the old code is still serving (Railway pre-deploy), so
// station ingests and audit reads wait for it. Keep the work under that lock
// small:
//   - ADD COLUMN of a nullable column with no default is catalogue-only.
//   - The CHECK is added NOT VALID, so Postgres does not scan every row to
//     prove it. Nothing needs proving: the column was created in this same
//     statement set, so every existing value is NULL, and the constraint is
//     still enforced on every INSERT and UPDATE from here on. (A later
//     VALIDATE CONSTRAINT, outside this chain, would only mark it validated.)
//   - The index is on a column that is NULL everywhere, but building it still
//     reads the table once; plain CREATE INDEX, not CONCURRENTLY, because
//     CONCURRENTLY refuses to run inside a transaction (same trade-off as
//     1752570000000-AddAssetAuditFeedIndexes).
//   - The backfill rewrites only rows whose profile carries a known lock
//     verdict. At this table's size (thousands of rows) that is seconds; if
//     asset_audits ever reaches hundreds of thousands of rows, run the same
//     UPDATE by hand in batches BEFORE deploying, and this one then touches
//     nothing (it skips rows whose lock_status is already set).
//
// BACKFILL lock_status for existing rows from hardware_profile, with the same
// rule the ingest uses (devices/wipe-detail.ts lockStatusOf): locks.status,
// else security.lockStatus, upper-cased, and only the four known values.
export class AddWipeRecordDetail1752650000000 implements MigrationInterface {
  name = 'AddWipeRecordDetail1752650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      ADD COLUMN IF NOT EXISTS "wiped_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "wipe_started_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "wiped_at_clock" varchar(16),
      ADD COLUMN IF NOT EXISTS "wiped_drive_serial" varchar(128),
      ADD COLUMN IF NOT EXISTS "wiped_drive" jsonb,
      ADD COLUMN IF NOT EXISTS "tool_name" varchar(64),
      ADD COLUMN IF NOT EXISTS "tool_version" varchar(64),
      ADD COLUMN IF NOT EXISTS "tool_commit" varchar(64),
      ADD COLUMN IF NOT EXISTS "wipe_method_requested" varchar(32),
      ADD COLUMN IF NOT EXISTS "wipe_method_attempted" varchar(255),
      ADD COLUMN IF NOT EXISTS "wipe_fallback_reason" varchar(255),
      ADD COLUMN IF NOT EXISTS "sanitisation_level" varchar(16),
      ADD COLUMN IF NOT EXISTS "wipe_verification" varchar(16),
      ADD COLUMN IF NOT EXISTS "hidden_areas" varchar(32),
      ADD COLUMN IF NOT EXISTS "lock_status" varchar(16),
      ADD COLUMN IF NOT EXISTS "wipe_limitations" jsonb,
      ADD COLUMN IF NOT EXISTS "wipe_smart" jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      DROP CONSTRAINT IF EXISTS "CHK_asset_audits_sanitisation_level"
    `);
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      ADD CONSTRAINT "CHK_asset_audits_sanitisation_level"
      CHECK ("sanitisation_level" IS NULL OR "sanitisation_level" IN ('purge', 'clear', 'none'))
      NOT VALID
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_asset_audits_wiped_drive_serial"
      ON "asset_audits" ("wiped_drive_serial")
    `);
    await queryRunner.query(`
      UPDATE "asset_audits"
      SET "lock_status" = UPPER(COALESCE(
        "hardware_profile"->'locks'->>'status',
        "hardware_profile"->'security'->>'lockStatus'
      ))
      WHERE "hardware_profile" IS NOT NULL
        AND "lock_status" IS NULL
        AND UPPER(COALESCE(
          "hardware_profile"->'locks'->>'status',
          "hardware_profile"->'security'->>'lockStatus'
        )) IN ('CLEAR', 'LOCKED', 'WARNING', 'UNVERIFIED')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_asset_audits_wiped_drive_serial"
    `);
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      DROP CONSTRAINT IF EXISTS "CHK_asset_audits_sanitisation_level"
    `);
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      DROP COLUMN IF EXISTS "wiped_at",
      DROP COLUMN IF EXISTS "wipe_started_at",
      DROP COLUMN IF EXISTS "wiped_at_clock",
      DROP COLUMN IF EXISTS "wiped_drive_serial",
      DROP COLUMN IF EXISTS "wiped_drive",
      DROP COLUMN IF EXISTS "tool_name",
      DROP COLUMN IF EXISTS "tool_version",
      DROP COLUMN IF EXISTS "tool_commit",
      DROP COLUMN IF EXISTS "wipe_method_requested",
      DROP COLUMN IF EXISTS "wipe_method_attempted",
      DROP COLUMN IF EXISTS "wipe_fallback_reason",
      DROP COLUMN IF EXISTS "sanitisation_level",
      DROP COLUMN IF EXISTS "wipe_verification",
      DROP COLUMN IF EXISTS "hidden_areas",
      DROP COLUMN IF EXISTS "lock_status",
      DROP COLUMN IF EXISTS "wipe_limitations",
      DROP COLUMN IF EXISTS "wipe_smart"
    `);
  }
}
