import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 0, slice 1 — the Product catalogue. Purely additive: a new standalone
// table with no foreign keys into it yet and, deliberately, NOT added to the
// "powersync" publication. So this migration cannot affect any existing row,
// query, or synced offline client. Sync wiring comes in a later slice once the
// tiers/sub-lots actually need the catalogue on-device.
export class CreateProducts1752100000000 implements MigrationInterface {
  name = 'CreateProducts1752100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "products_tracking_type_enum" AS ENUM ('serialized', 'bulk', 'pallet')
    `);
    await queryRunner.query(`
      CREATE TABLE "products" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sku" character varying,
        "name" character varying NOT NULL,
        "category" character varying,
        "tracking_type" "products_tracking_type_enum" NOT NULL DEFAULT 'serialized',
        "manufacturer" character varying,
        "model" character varying,
        "cpu" character varying,
        "ram_gb" integer,
        "storage" character varying,
        "screen_size" character varying,
        "attributes" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_products_sku" UNIQUE ("sku"),
        CONSTRAINT "PK_products" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_products_tracking_type" ON "products" ("tracking_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_products_category" ON "products" ("category")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_products_category"`);
    await queryRunner.query(`DROP INDEX "IDX_products_tracking_type"`);
    await queryRunner.query(`DROP TABLE "products"`);
    await queryRunner.query(`DROP TYPE "products_tracking_type_enum"`);
  }
}
