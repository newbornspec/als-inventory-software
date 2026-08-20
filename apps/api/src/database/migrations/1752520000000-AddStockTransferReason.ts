import { MigrationInterface, QueryRunner } from 'typeorm';

// Moving consumables between locations is a real warehouse action that the
// movement log could not express: a StockLine is (item, location), so a move is
// two rows — one out of the source line, one into the destination — and both
// need a reason that says what happened. Recording them as 'adjusted' would put
// a transfer in the same bucket as a recount, and the pair would read as stock
// appearing and disappearing rather than moving.
//
// Serialized devices already have their equivalent: changing an asset's
// location writes an AssetEventType.TRANSFERRED history row
// (assets.service.ts). This is the consumables half of the same idea.
//
// ALTER TYPE ... ADD VALUE is additive and cannot orphan existing rows. It is
// also NOT reversible — Postgres has no DROP VALUE — so down() is deliberately
// a no-op rather than a lie. Same shape as 1752400000000, which added 'sold' to
// the asset status enum.
export class AddStockTransferReason1752520000000 implements MigrationInterface {
  name = 'AddStockTransferReason1752520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "stock_movements_reason_enum" ADD VALUE IF NOT EXISTS 'transferred'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot remove an enum value. Rolling this back would mean
    // rebuilding the type and rewriting every stock_movements row, which is a
    // far bigger risk than leaving an unused label in place.
  }
}
