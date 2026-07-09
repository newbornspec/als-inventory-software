import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1751990400000 implements MigrationInterface {
  name = 'InitSchema1751990400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TYPE "users_role_enum" AS ENUM ('admin', 'manager', 'technician')
    `);
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "email" character varying NOT NULL,
        "password_hash" character varying NOT NULL,
        "role" "users_role_enum" NOT NULL DEFAULT 'technician',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "locations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "address" character varying,
        "assigned_user_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_locations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_locations_assigned_user" FOREIGN KEY ("assigned_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "assets_status_enum" AS ENUM ('in_stock', 'assigned', 'in_repair', 'retired')
    `);
    await queryRunner.query(`
      CREATE TABLE "assets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tag" character varying NOT NULL,
        "name" character varying NOT NULL,
        "category" character varying NOT NULL,
        "status" "assets_status_enum" NOT NULL DEFAULT 'in_stock',
        "location_id" uuid,
        "owner_id" uuid,
        "image_url" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_assets_tag" UNIQUE ("tag"),
        CONSTRAINT "PK_assets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_assets_location" FOREIGN KEY ("location_id")
          REFERENCES "locations"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_assets_owner" FOREIGN KEY ("owner_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "asset_history_event_type_enum" AS ENUM
        ('created', 'scanned', 'transferred', 'status_changed', 'retired')
    `);
    await queryRunner.query(`
      CREATE TABLE "asset_history" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "asset_id" uuid NOT NULL,
        "event_type" "asset_history_event_type_enum" NOT NULL,
        "user_id" uuid,
        "notes" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_asset_history" PRIMARY KEY ("id"),
        CONSTRAINT "FK_asset_history_asset" FOREIGN KEY ("asset_id")
          REFERENCES "assets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_asset_history_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_assets_location_id" ON "assets" ("location_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_asset_history_asset_id" ON "asset_history" ("asset_id")`);

    // Required so PowerSync can stream changes — "powersync" is the specific
    // name PowerSync's self-hosted service looks for by default.
    await queryRunner.query(`
      CREATE PUBLICATION powersync FOR TABLE assets, asset_history, locations, users
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP PUBLICATION IF EXISTS powersync`);
    await queryRunner.query(`DROP TABLE "asset_history"`);
    await queryRunner.query(`DROP TYPE "asset_history_event_type_enum"`);
    await queryRunner.query(`DROP TABLE "assets"`);
    await queryRunner.query(`DROP TYPE "assets_status_enum"`);
    await queryRunner.query(`DROP TABLE "locations"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "users_role_enum"`);
  }
}
