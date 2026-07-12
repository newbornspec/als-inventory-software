import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 5b — device photos stored in Postgres (bytea). Client compresses before
// upload so rows stay small. Additive; online-managed (not in powersync).
export class CreateAssetPhotos1752290000000 implements MigrationInterface {
  name = 'CreateAssetPhotos1752290000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "asset_photos" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "asset_id" uuid NOT NULL,
        "data" bytea NOT NULL,
        "content_type" character varying NOT NULL,
        "caption" character varying,
        "uploaded_by_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_asset_photos" PRIMARY KEY ("id"),
        CONSTRAINT "FK_asset_photos_asset" FOREIGN KEY ("asset_id")
          REFERENCES "assets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_asset_photos_user" FOREIGN KEY ("uploaded_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_asset_photos_asset_id" ON "asset_photos" ("asset_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_asset_photos_asset_id"`);
    await queryRunner.query(`DROP TABLE "asset_photos"`);
  }
}
