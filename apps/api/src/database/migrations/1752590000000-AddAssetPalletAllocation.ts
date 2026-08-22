import { MigrationInterface, QueryRunner } from 'typeorm';

// Goods In -> Move to Pallet: a serialized device can now be allocated onto a
// pallet, so assets gains the allocation trio — which pallet, when, by whom —
// mirroring the sold stamp's shape (sold_at / sold_by_id).
//
// The modelling decision this encodes (locked with the client): a pallet is
// line-based OR asset-based, NEVER both. pallet.entry_layout (already a
// free-text varchar precisely so new layouts need no migration) gains the
// runtime value 'asset'; an asset pallet holds device rows via this FK and
// has no pallet_lines, so every existing consumer that sums pallet_lines
// keeps meaning exactly what it meant — an asset pallet simply contributes
// nothing there, and its devices keep being counted where they always were:
// as serialized assets. No stock total changes meaning on deploy day.
//
// ON DELETE SET NULL on both FKs, deliberately:
//   - pallets: the service refuses to delete a pallet that still holds
//     devices, but if a row ever goes another way the devices must fall back
//     into their lot pools — CASCADE here would delete real devices and their
//     entire audit trail (asset_audits/asset_history cascade off assets).
//   - users: deleting an account must never delete or orphan a device.
//
// Also adds 'allocated' to the asset_history event enum. ADD VALUE only —
// nothing in this migration USES the label, so the 55P04 same-transaction
// trap (see 1752550000000's ::text cast) does not apply; the runtime writes
// it only after this has committed.
export class AddAssetPalletAllocation1752590000000 implements MigrationInterface {
  name = 'AddAssetPalletAllocation1752590000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assets" ADD COLUMN "pallet_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "assets" ADD COLUMN "moved_to_pallet_at" TIMESTAMP
    `);
    await queryRunner.query(`
      ALTER TABLE "assets" ADD COLUMN "moved_to_pallet_by_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "assets"
      ADD CONSTRAINT "FK_assets_pallet" FOREIGN KEY ("pallet_id")
        REFERENCES "pallets"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "assets"
      ADD CONSTRAINT "FK_assets_moved_to_pallet_by" FOREIGN KEY ("moved_to_pallet_by_id")
        REFERENCES "users"("id") ON DELETE SET NULL
    `);
    // The pallet detail page and every pool predicate filter on this.
    await queryRunner.query(`
      CREATE INDEX "IDX_assets_pallet_id" ON "assets" ("pallet_id")
      WHERE "pallet_id" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TYPE "asset_history_event_type_enum" ADD VALUE IF NOT EXISTS 'allocated'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_assets_pallet_id"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "FK_assets_moved_to_pallet_by"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "FK_assets_pallet"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "moved_to_pallet_by_id"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "moved_to_pallet_at"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "pallet_id"`);
    // Postgres cannot remove an enum value; 'allocated' stays, harmlessly.
  }
}
