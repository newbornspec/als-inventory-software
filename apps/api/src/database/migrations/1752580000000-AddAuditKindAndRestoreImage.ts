import { MigrationInterface, QueryRunner } from 'typeorm';

// Four nullable columns on asset_audits, all fed by the phase-5 kiosk update
// and the web audit form. Additive only: no backfill, no row is touched.
//
// audit_kind ('amazon' | 'goods_in'): which workflow filed the event. Every
// EXISTING row stays NULL — deliberately. Nothing in the data distinguishes an
// Amazon audit from a Goods In receiving audit (the kiosk logs in as one
// shared account, the lot's source is free text, and the note wording lives on
// a different table), so a backfill would be a guess, and guessing on a
// compliance table is worse than "Unclassified".
//
// operator_name: the human at the Audit Station. The station authenticates as
// ONE shared account per USB stick, so audited_by_id names the same user for
// every kiosk row ever filed — the actual operator was never captured. Free
// text from the station's operator field, not a users FK: station operators
// aren't necessarily app users, and the kiosk has no access to user ids.
//
// restore_image_status ('installed' | 'failed') + restore_image_name: the OS
// restore result. The kiosk has always PERFORMED installs but never reported
// them — the result died in its in-memory job table. varchar rather than a pg
// enum, following pallet.entryLayout's precedent: kiosk-fed vocabularies grow,
// and an enum turns each new value into a migration (and a 55P04 hazard).
// The API validates values at the DTO instead.
//
// Old sticks in the field keep posting payloads without any of these fields
// indefinitely; every column is nullable and every DTO field optional, so
// their uploads keep working unchanged.
export class AddAuditKindAndRestoreImage1752580000000 implements MigrationInterface {
  name = 'AddAuditKindAndRestoreImage1752580000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "asset_audits" ADD COLUMN "audit_kind" character varying`);
    await queryRunner.query(`ALTER TABLE "asset_audits" ADD COLUMN "operator_name" character varying`);
    await queryRunner.query(`ALTER TABLE "asset_audits" ADD COLUMN "restore_image_status" character varying`);
    await queryRunner.query(`ALTER TABLE "asset_audits" ADD COLUMN "restore_image_name" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "asset_audits" DROP COLUMN "restore_image_name"`);
    await queryRunner.query(`ALTER TABLE "asset_audits" DROP COLUMN "restore_image_status"`);
    await queryRunner.query(`ALTER TABLE "asset_audits" DROP COLUMN "operator_name"`);
    await queryRunner.query(`ALTER TABLE "asset_audits" DROP COLUMN "audit_kind"`);
  }
}
