import { MigrationInterface, QueryRunner } from 'typeorm';

// Records which New-Pallet layout created a pallet, so each layout can export a
// different report: 'variant' (Layout 1, the original report) or 'spec'
// (Layout 2, the split-column report). Additive & nullable; existing pallets
// default to 'variant', except ones whose every line already links a catalogue
// product — those were built with the Layout 2 spec table, so backfill 'spec'.
export class AddPalletEntryLayout1752380000000 implements MigrationInterface {
  name = 'AddPalletEntryLayout1752380000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pallets" ADD COLUMN IF NOT EXISTS "entry_layout" character varying DEFAULT 'variant'`,
    );
    // Any pre-existing pallet whose lines all link a product came from Layout 2.
    await queryRunner.query(`
      UPDATE "pallets" p SET "entry_layout" = 'spec'
      WHERE EXISTS (SELECT 1 FROM "pallet_lines" l WHERE l.pallet_id = p.id)
        AND NOT EXISTS (
          SELECT 1 FROM "pallet_lines" l
          WHERE l.pallet_id = p.id AND l.product_id IS NULL
        )
    `);
    await queryRunner.query(
      `UPDATE "pallets" SET "entry_layout" = 'variant' WHERE "entry_layout" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pallets" DROP COLUMN IF EXISTS "entry_layout"`);
  }
}
