import { MigrationInterface, QueryRunner } from 'typeorm';

// Every audited device gets a permanent Unit ID (U-000001), the third level of
// the identification hierarchy: Batch -> Lot -> Unit.
//
// Deliberately INDEPENDENT of the lot. Assets move between lots (the lot page
// has a "Move to" control), so a Unit ID that encoded its lot would be wrong
// the moment a device moved, invalidating every label already stuck on it. The
// batch/lot relationship stays in the foreign keys and is resolved at print
// time, so a label always shows the CURRENT lot while the Unit ID stays true
// for the device's whole life.
//
// Nullable on purpose: the column is added and backfilled here, but making it
// NOT NULL would break the window between this migration and the code deploy.
export class AddAssetUnitId1752430000000 implements MigrationInterface {
  name = 'AddAssetUnitId1752430000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "unit_number_seq"`);
    await queryRunner.query(`ALTER TABLE "assets" ADD COLUMN "unit_id" character varying`);

    // Backfill in creation order so the oldest device is U-000001 and the
    // numbering reads chronologically. ROW_NUMBER is used rather than calling
    // nextval() inside an ordered subquery: Postgres does not guarantee the
    // order in which nextval() is evaluated, so that approach would still be
    // unique but could number the rows out of sequence.
    await queryRunner.query(`
      WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY "created_at" ASC, id ASC) AS rn
        FROM "assets"
      )
      UPDATE "assets" AS a
      SET "unit_id" = 'U-' || LPAD(o.rn::text, 6, '0')
      FROM ordered AS o
      WHERE a.id = o.id
    `);

    // Advance the sequence past everything just assigned, so the next device
    // audited continues the run instead of colliding. The third argument is
    // is_called: with no existing assets it stays false so the first nextval()
    // returns 1 (setval(seq, 0) would be rejected).
    await queryRunner.query(`
      SELECT setval(
        'unit_number_seq',
        GREATEST((SELECT COUNT(*) FROM "assets"), 1),
        (SELECT COUNT(*) FROM "assets") > 0
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "assets" ADD CONSTRAINT "UQ_assets_unit_id" UNIQUE ("unit_id")`,
    );
    // Scanning a printed label resolves the device by this value.
    await queryRunner.query(`CREATE INDEX "IDX_assets_unit_id" ON "assets" ("unit_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_assets_unit_id"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "UQ_assets_unit_id"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "unit_id"`);
    await queryRunner.query(`DROP SEQUENCE "unit_number_seq"`);
  }
}
