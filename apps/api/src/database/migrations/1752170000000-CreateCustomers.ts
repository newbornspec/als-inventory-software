import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 6.1 — customers, the foundation for sales orders. Additive standalone
// table, not in the powersync publication.
export class CreateCustomers1752170000000 implements MigrationInterface {
  name = 'CreateCustomers1752170000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "customers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying NOT NULL,
        "email" character varying,
        "phone" character varying,
        "notes" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_customers" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "customers"`);
  }
}
