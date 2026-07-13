import { MigrationInterface, QueryRunner } from 'typeorm';

// The lot a user is currently auditing into. The bootable capture tool reads
// this so the operator picks the lot once in the web, then just runs the script.
export class AddUserActiveAuditLot1752330000000 implements MigrationInterface {
  name = 'AddUserActiveAuditLot1752330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "active_audit_lot_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_users_active_audit_lot" FOREIGN KEY ("active_audit_lot_id") REFERENCES "batches"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "FK_users_active_audit_lot"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "active_audit_lot_id"`);
  }
}
