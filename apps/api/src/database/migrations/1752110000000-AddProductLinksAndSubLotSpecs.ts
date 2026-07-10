import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 0, slice 2 — wire the catalogue into the schema and give the `lots`
// table (which becomes the sub-lot spec bucket) a declared specification.
//
// Purely additive: only ADD COLUMN / ADD CONSTRAINT / CREATE INDEX, no renames
// and no dropped columns, so existing rows and queries are untouched. `assets`
// and `lots` are already in the "powersync" publication with no column list, so
// Postgres replicates these new columns automatically — the client schema picks
// them up in slice 4; until then they simply sync as unknown columns (ignored).
export class AddProductLinksAndSubLotSpecs1752110000000 implements MigrationInterface {
  name = 'AddProductLinksAndSubLotSpecs1752110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Serialized assets can reference a catalogue product (nullable — legacy
    // and non-catalogue assets simply have none).
    await queryRunner.query(`ALTER TABLE "assets" ADD COLUMN "product_id" uuid`);
    await queryRunner.query(`
      ALTER TABLE "assets" ADD CONSTRAINT "FK_assets_product"
        FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`CREATE INDEX "IDX_assets_product_id" ON "assets" ("product_id")`);

    // A sub-lot (the repurposed `lots` table) carries the declared spec set once
    // by the operator; every unit scanned into it inherits this. product_id lets
    // that spec resolve to a catalogue entry; the loose columns cover a spec
    // typed in before it's been saved to the catalogue.
    await queryRunner.query(`ALTER TABLE "lots" ADD COLUMN "product_id" uuid`);
    await queryRunner.query(`
      ALTER TABLE "lots" ADD CONSTRAINT "FK_lots_product"
        FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`ALTER TABLE "lots" ADD COLUMN "manufacturer" character varying`);
    await queryRunner.query(`ALTER TABLE "lots" ADD COLUMN "model" character varying`);
    await queryRunner.query(`ALTER TABLE "lots" ADD COLUMN "cpu" character varying`);
    await queryRunner.query(`ALTER TABLE "lots" ADD COLUMN "ram_gb" integer`);
    await queryRunner.query(`ALTER TABLE "lots" ADD COLUMN "storage" character varying`);
    await queryRunner.query(`ALTER TABLE "lots" ADD COLUMN "screen_size" character varying`);
    await queryRunner.query(`CREATE INDEX "IDX_lots_product_id" ON "lots" ("product_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_lots_product_id"`);
    await queryRunner.query(`ALTER TABLE "lots" DROP COLUMN "screen_size"`);
    await queryRunner.query(`ALTER TABLE "lots" DROP COLUMN "storage"`);
    await queryRunner.query(`ALTER TABLE "lots" DROP COLUMN "ram_gb"`);
    await queryRunner.query(`ALTER TABLE "lots" DROP COLUMN "cpu"`);
    await queryRunner.query(`ALTER TABLE "lots" DROP COLUMN "model"`);
    await queryRunner.query(`ALTER TABLE "lots" DROP COLUMN "manufacturer"`);
    await queryRunner.query(`ALTER TABLE "lots" DROP CONSTRAINT "FK_lots_product"`);
    await queryRunner.query(`ALTER TABLE "lots" DROP COLUMN "product_id"`);

    await queryRunner.query(`DROP INDEX "IDX_assets_product_id"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "FK_assets_product"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "product_id"`);
  }
}
