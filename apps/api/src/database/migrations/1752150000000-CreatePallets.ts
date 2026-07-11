import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 3.1 — monitor pallets: a container holding counted quantities by
// variant. Purely additive new tables; deliberately NOT added to the
// "powersync" publication (pallets are managed online, not offline-scanned),
// so no sync impact.
export class CreatePallets1752150000000 implements MigrationInterface {
  name = 'CreatePallets1752150000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE "pallet_number_seq"`);
    await queryRunner.query(
      `CREATE TYPE "pallets_status_enum" AS ENUM ('open', 'ready', 'shipped')`,
    );
    await queryRunner.query(`
      CREATE TABLE "pallets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "pallet_number" character varying NOT NULL,
        "description" character varying,
        "location_id" uuid,
        "status" "pallets_status_enum" NOT NULL DEFAULT 'open',
        "notes" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_pallets_pallet_number" UNIQUE ("pallet_number"),
        CONSTRAINT "PK_pallets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_pallets_location" FOREIGN KEY ("location_id")
          REFERENCES "locations"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "pallet_lines" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "pallet_id" uuid NOT NULL,
        "variant" character varying NOT NULL,
        "quantity" integer NOT NULL DEFAULT 0,
        "product_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_pallet_lines" PRIMARY KEY ("id"),
        CONSTRAINT "FK_pallet_lines_pallet" FOREIGN KEY ("pallet_id")
          REFERENCES "pallets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_pallet_lines_product" FOREIGN KEY ("product_id")
          REFERENCES "products"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_pallet_lines_pallet_id" ON "pallet_lines" ("pallet_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_pallet_lines_pallet_id"`);
    await queryRunner.query(`DROP TABLE "pallet_lines"`);
    await queryRunner.query(`DROP TABLE "pallets"`);
    await queryRunner.query(`DROP TYPE "pallets_status_enum"`);
    await queryRunner.query(`DROP SEQUENCE "pallet_number_seq"`);
  }
}
