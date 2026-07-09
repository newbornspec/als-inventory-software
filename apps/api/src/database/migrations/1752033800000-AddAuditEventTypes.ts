import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuditEventTypes1752033800000 implements MigrationInterface {
  name = 'AddAuditEventTypes1752033800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "asset_history_event_type_enum" ADD VALUE IF NOT EXISTS 'condition_changed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "asset_history_event_type_enum" ADD VALUE IF NOT EXISTS 'audited'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres doesn't support removing enum values — a no-op down is the
    // standard approach; reverting would require rebuilding the type.
  }
}
