import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBatchesAndLots1752040000000 implements MigrationInterface {
  name = 'CreateBatchesAndLots1752040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE "batch_number_seq"`);
    await queryRunner.query(`CREATE SEQUENCE "lot_number_seq"`);

    await queryRunner.query(`
      CREATE TYPE "batches_status_enum" AS ENUM ('open', 'receiving', 'closed', 'reconciled')
    `);
    await queryRunner.query(`
      CREATE TABLE "batches" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "batch_number" character varying NOT NULL,
        "source" character varying,
        "location_id" uuid,
        "received_by_id" uuid,
        "received_date" DATE,
        "expected_unit_count" integer,
        "status" "batches_status_enum" NOT NULL DEFAULT 'open',
        "notes" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_batches_batch_number" UNIQUE ("batch_number"),
        CONSTRAINT "PK_batches" PRIMARY KEY ("id"),
        CONSTRAINT "FK_batches_location" FOREIGN KEY ("location_id")
          REFERENCES "locations"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_batches_received_by" FOREIGN KEY ("received_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`CREATE TYPE "lots_status_enum" AS ENUM ('open', 'closed')`);
    await queryRunner.query(`
      CREATE TABLE "lots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "lot_number" character varying NOT NULL,
        "batch_id" uuid,
        "description" character varying,
        "expected_unit_count" integer,
        "status" "lots_status_enum" NOT NULL DEFAULT 'open',
        "notes" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_lots_lot_number" UNIQUE ("lot_number"),
        CONSTRAINT "PK_lots" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lots_batch" FOREIGN KEY ("batch_id")
          REFERENCES "batches"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "assets" ADD COLUMN "batch_id" uuid,
      ADD CONSTRAINT "FK_assets_batch" FOREIGN KEY ("batch_id")
        REFERENCES "batches"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "assets" ADD COLUMN "lot_id" uuid,
      ADD CONSTRAINT "FK_assets_lot" FOREIGN KEY ("lot_id")
        REFERENCES "lots"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`CREATE INDEX "IDX_assets_batch_id" ON "assets" ("batch_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_assets_lot_id" ON "assets" ("lot_id")`);

    await queryRunner.query(`ALTER PUBLICATION "powersync" ADD TABLE "batches", "lots"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER PUBLICATION "powersync" DROP TABLE "batches", "lots"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "FK_assets_lot"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "FK_assets_batch"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "lot_id"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "batch_id"`);
    await queryRunner.query(`DROP TABLE "lots"`);
    await queryRunner.query(`DROP TYPE "lots_status_enum"`);
    await queryRunner.query(`DROP TABLE "batches"`);
    await queryRunner.query(`DROP TYPE "batches_status_enum"`);
    await queryRunner.query(`DROP SEQUENCE "lot_number_seq"`);
    await queryRunner.query(`DROP SEQUENCE "batch_number_seq"`);
  }
}
