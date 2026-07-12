import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 6.2 — sales orders + line items. Additive; not in the powersync
// publication (sales are managed online).
export class CreateSalesOrders1752180000000 implements MigrationInterface {
  name = 'CreateSalesOrders1752180000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE "order_number_seq"`);
    await queryRunner.query(`
      CREATE TYPE "sales_orders_status_enum" AS ENUM
        ('draft', 'reserved', 'picking', 'picked', 'invoiced', 'shipped', 'completed', 'cancelled')
    `);
    await queryRunner.query(`
      CREATE TABLE "sales_orders" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "order_number" character varying NOT NULL,
        "customer_id" uuid,
        "status" "sales_orders_status_enum" NOT NULL DEFAULT 'draft',
        "order_ref" character varying,
        "notes" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_sales_orders_order_number" UNIQUE ("order_number"),
        CONSTRAINT "PK_sales_orders" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sales_orders_customer" FOREIGN KEY ("customer_id")
          REFERENCES "customers"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "order_lines" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "order_id" uuid NOT NULL,
        "description" character varying,
        "asset_id" uuid,
        "quantity" integer NOT NULL DEFAULT 1,
        "unit_price" numeric(12,2),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_lines" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_lines_order" FOREIGN KEY ("order_id")
          REFERENCES "sales_orders"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_order_lines_asset" FOREIGN KEY ("asset_id")
          REFERENCES "assets"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_order_lines_order" ON "order_lines" ("order_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_order_lines_order"`);
    await queryRunner.query(`DROP TABLE "order_lines"`);
    await queryRunner.query(`DROP TABLE "sales_orders"`);
    await queryRunner.query(`DROP TYPE "sales_orders_status_enum"`);
    await queryRunner.query(`DROP SEQUENCE "order_number_seq"`);
  }
}
