import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 3.3 — bulk consumables: quantity-tracked stock + an append-only
// movement log. Additive new tables, NOT in the "powersync" publication
// (managed online) — no sync impact.
export class CreateStock1752160000000 implements MigrationInterface {
  name = 'CreateStock1752160000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "stock_movements_reason_enum"
        AS ENUM ('received', 'sold', 'adjusted', 'returned', 'scrapped')
    `);
    await queryRunner.query(`
      CREATE TABLE "stock_lines" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "sku" character varying,
        "category" character varying,
        "product_id" uuid,
        "location_id" uuid,
        "quantity" integer NOT NULL DEFAULT 0,
        "notes" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_stock_lines" PRIMARY KEY ("id"),
        CONSTRAINT "FK_stock_lines_product" FOREIGN KEY ("product_id")
          REFERENCES "products"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_stock_lines_location" FOREIGN KEY ("location_id")
          REFERENCES "locations"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "stock_movements" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "stock_line_id" uuid NOT NULL,
        "delta" integer NOT NULL,
        "reason" "stock_movements_reason_enum" NOT NULL,
        "note" character varying,
        "user_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_stock_movements" PRIMARY KEY ("id"),
        CONSTRAINT "FK_stock_movements_line" FOREIGN KEY ("stock_line_id")
          REFERENCES "stock_lines"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_stock_movements_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movements_line" ON "stock_movements" ("stock_line_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_stock_movements_line"`);
    await queryRunner.query(`DROP TABLE "stock_movements"`);
    await queryRunner.query(`DROP TABLE "stock_lines"`);
    await queryRunner.query(`DROP TYPE "stock_movements_reason_enum"`);
  }
}
