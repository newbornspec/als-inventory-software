import { MigrationInterface, QueryRunner } from 'typeorm';

// Put Gen's "None" at the top of its list instead of between 1st Gen and 2nd Gen.
//
// 1752470000000 seeded it at sort_order 0, which is also 1st Gen's. Lookups are
// ordered `sortOrder ASC, value ASC` (lookups.service.ts:18-19), so the tie fell
// through to the value — and "1st Gen" sorts before "None", because '1' is 0x31
// and 'N' is 0x4E. The result read 1st Gen, None, 2nd Gen.
//
// -1 sorts it ahead of every generation without renumbering the fourteen that
// are already there, and without relying on a tiebreak at all.
export class FixGenNoneOrder1752480000000 implements MigrationInterface {
  name = 'FixGenNoneOrder1752480000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "lookup_values" SET "sort_order" = -1
       WHERE "category" = 'gen' AND "value" = 'None'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "lookup_values" SET "sort_order" = 0
       WHERE "category" = 'gen' AND "value" = 'None'`,
    );
  }
}
