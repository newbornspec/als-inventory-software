import { MigrationInterface, QueryRunner } from 'typeorm';

// Pallet invoicing. An invoice is a legal record of what was sent to a buyer on
// a day, so almost everything here is a SNAPSHOT rather than a reference:
//
//  - buyer name and address, because a customer who moves next year must not
//    silently rewrite last year's invoice;
//  - the VAT number and rate, for the same reason — rates change;
//  - subtotal, VAT and total, so a reprint is byte-identical rather than
//    recomputed from figures that may since have been edited;
//  - the item lines as JSON, because selling a pallet line DELETES it
//    (pallets.service.ts sellLine), so an invoice pointing at live lines would
//    empty itself the moment the pallet sold.
//
// pallet_id is kept as a soft link for navigation only, ON DELETE SET NULL —
// deleting a pallet must never delete the invoice raised against it.
export class AddInvoices1752490000000 implements MigrationInterface {
  name = 'AddInvoices1752490000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Per-year counter. The five existing sequences (batch/lot/pallet/order/
    // unit) are all plain CREATE SEQUENCE, which cannot restart on 1 January —
    // a sequence would hand out INV-2027-0043 in the new year. One row per
    // year, incremented atomically in a single statement, gives the requested
    // INV-YYYY-NNNN and resets naturally.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "invoice_counters" (
        "year" integer NOT NULL,
        "last_number" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_invoice_counters" PRIMARY KEY ("year")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "invoices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "invoice_number" character varying NOT NULL,
        "invoice_year" integer NOT NULL,
        "invoice_date" date NOT NULL,

        -- Soft link + snapshot. The number is what the document shows.
        "pallet_id" uuid,
        "pallet_number" character varying NOT NULL,

        "buyer_name" character varying NOT NULL,
        "buyer_address1" character varying,
        "buyer_address2" character varying,
        "buyer_city" character varying,
        "buyer_postcode" character varying,
        "buyer_country" character varying,

        -- vat_number and vat_rate are NULL when not registered; the boolean is
        -- what the document reads, so "not registered" can never be confused
        -- with "registered but nobody filled the rate in".
        "vat_registered" boolean NOT NULL DEFAULT false,
        "vat_number" character varying,
        "vat_rate" numeric(5,2),

        "subtotal" numeric(12,2) NOT NULL,
        "vat_amount" numeric(12,2) NOT NULL DEFAULT 0,
        "total" numeric(12,2) NOT NULL,

        "lines" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "notes" character varying,

        "created_by_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),

        CONSTRAINT "PK_invoices" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_invoices_number" UNIQUE ("invoice_number")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "invoices" ADD CONSTRAINT "FK_invoices_pallet"
       FOREIGN KEY ("pallet_id") REFERENCES "pallets"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoices" ADD CONSTRAINT "FK_invoices_created_by"
       FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_invoices_pallet" ON "invoices" ("pallet_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "invoices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_counters"`);
  }
}
