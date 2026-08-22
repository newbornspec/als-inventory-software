import { MigrationInterface, QueryRunner } from 'typeorm';

// The Audit workspace reads asset_audits ACROSS assets, newest first, grouped
// by day — and the table's only index is asset_id (its one reader until now
// was the per-device history list). Without this, every day-header render is
// a sequential scan plus sort.
//
// Plain CREATE INDEX, not CONCURRENTLY: TypeORM runs the chain in one
// transaction and CONCURRENTLY refuses to run inside one. The brief lock is a
// non-issue at this table's size; if asset_audits ever grows to where it
// matters, build the replacement index CONCURRENTLY by hand first.
export class AddAssetAuditFeedIndexes1752570000000 implements MigrationInterface {
  name = 'AddAssetAuditFeedIndexes1752570000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "IDX_asset_audits_created_at" ON "asset_audits" ("created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_asset_audits_created_at"`);
  }
}
