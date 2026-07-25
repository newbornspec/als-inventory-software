import { MigrationInterface, QueryRunner } from 'typeorm';

// Lots can be sold as a whole: 'sold' joins the batch status enum. Selling a
// lot marks every remaining device in it Sold (see BatchesService.sellBatch).
export class AddBatchSoldStatus1752410000000 implements MigrationInterface {
  name = 'AddBatchSoldStatus1752410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "batches_status_enum" ADD VALUE IF NOT EXISTS 'sold'`);
  }

  public async down(): Promise<void> {
    // Postgres can't remove an enum value; 'sold' stays (harmlessly) on down.
  }
}
