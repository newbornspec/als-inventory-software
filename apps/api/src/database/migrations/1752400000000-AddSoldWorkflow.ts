import { MigrationInterface, QueryRunner } from 'typeorm';

// The Sold workflow: assets gain a terminal 'sold' stock status (+ who/when),
// and pallet goods sold by line/quantity are archived in pallet_sold_lines —
// each row is a quantity that left a pallet, with full provenance for the Sold
// page and admin-only return-to-inventory. All additive.
export class AddSoldWorkflow1752400000000 implements MigrationInterface {
  name = 'AddSoldWorkflow1752400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "assets_stock_status_enum" ADD VALUE IF NOT EXISTS 'sold'`,
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "sold_at" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "sold_by_id" uuid`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_assets_sold_by') THEN
          ALTER TABLE "assets" ADD CONSTRAINT "FK_assets_sold_by"
            FOREIGN KEY ("sold_by_id") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pallet_sold_lines" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "pallet_id" uuid,
        "pallet_number" character varying NOT NULL,
        "product_id" uuid,
        "variant" character varying NOT NULL,
        "quantity" integer NOT NULL,
        "sold_at" TIMESTAMP NOT NULL DEFAULT now(),
        "sold_by_id" uuid,
        "returned_at" TIMESTAMP,
        "returned_by_id" uuid,
        "returned_to_pallet_id" uuid,
        CONSTRAINT "PK_pallet_sold_lines" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_psl_pallet') THEN
          ALTER TABLE "pallet_sold_lines" ADD CONSTRAINT "FK_psl_pallet"
            FOREIGN KEY ("pallet_id") REFERENCES "pallets"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_psl_product') THEN
          ALTER TABLE "pallet_sold_lines" ADD CONSTRAINT "FK_psl_product"
            FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_psl_sold_by') THEN
          ALTER TABLE "pallet_sold_lines" ADD CONSTRAINT "FK_psl_sold_by"
            FOREIGN KEY ("sold_by_id") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_psl_returned_by') THEN
          ALTER TABLE "pallet_sold_lines" ADD CONSTRAINT "FK_psl_returned_by"
            FOREIGN KEY ("returned_by_id") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "pallet_sold_lines"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "sold_by_id"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN IF EXISTS "sold_at"`);
    // Postgres can't remove an enum value; 'sold' stays (harmlessly) on down.
  }
}
