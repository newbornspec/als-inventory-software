import { MigrationInterface, QueryRunner } from 'typeorm';

// Consumables are used internally, not sold — rename the movement reason.
export class RenameStockReasonSoldToUsed1752310000000 implements MigrationInterface {
  name = 'RenameStockReasonSoldToUsed1752310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "stock_movements_reason_enum" RENAME VALUE 'sold' TO 'used'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "stock_movements_reason_enum" RENAME VALUE 'used' TO 'sold'`,
    );
  }
}
