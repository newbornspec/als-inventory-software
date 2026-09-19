import { MigrationInterface, QueryRunner } from 'typeorm';

// Who recorded a wipe outcome: 'station' (the ALS audit station, which erased
// the drive and read it back) or 'manual' (typed into the web app by a person).
// See assets/manual-wipe.ts. The certificate words a manual record differently,
// because it never was verified.
//
// varchar + CHECK rather than a Postgres enum, so adding a source later is a
// constraint change, not an enum migration that has to land before the code.
//
// BACKFILL. Every existing row that recorded a wipe status gets a source, using
// the one signal that reliably separates the two: only the station ingest
// (devices.service.ts) ever stores a hardware profile on an audit row. The web
// DTO has no such field, and the web's offline form never sends one. So a
// profile means the station; no profile means a person typed it. This means
// old hand-typed "Wiped" records will re-download with the manual wording -
// which is the point: they were never verified.
export class AddWipeSource1752640000000 implements MigrationInterface {
  name = 'AddWipeSource1752640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      ADD COLUMN IF NOT EXISTS "wipe_source" varchar(16)
    `);
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      DROP CONSTRAINT IF EXISTS "CHK_asset_audits_wipe_source"
    `);
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      ADD CONSTRAINT "CHK_asset_audits_wipe_source"
      CHECK ("wipe_source" IS NULL OR "wipe_source" IN ('station', 'manual'))
    `);
    await queryRunner.query(`
      UPDATE "asset_audits"
      SET "wipe_source" = CASE WHEN "hardware_profile" IS NOT NULL THEN 'station' ELSE 'manual' END
      WHERE "data_wipe_status" IS NOT NULL AND "wipe_source" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      DROP CONSTRAINT IF EXISTS "CHK_asset_audits_wipe_source"
    `);
    await queryRunner.query(`
      ALTER TABLE "asset_audits"
      DROP COLUMN IF EXISTS "wipe_source"
    `);
  }
}
