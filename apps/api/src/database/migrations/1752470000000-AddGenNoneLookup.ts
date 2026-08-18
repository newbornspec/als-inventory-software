import { MigrationInterface, QueryRunner } from 'typeorm';

// "None" joins the Gen suggestions, for machines that have no CPU generation —
// a Core 2 Duo or a Pentium predates the numbering entirely, so leaving the cell
// blank makes "no generation" look identical to "nobody filled this in".
//
// sort_order 0 puts it above 1st Gen, matching where None sits in the CPU and
// RAM dropdowns. The existing generations are untouched: they were seeded from
// 0 upwards by 1752390000000, so this shares 0 with "1st Gen" — lookups are
// ordered by sort_order then value, and "1st Gen" already sorts after "None".
export class AddGenNoneLookup1752470000000 implements MigrationInterface {
  name = 'AddGenNoneLookup1752470000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // VALUES, not SELECT — Postgres infers the parameter types from the target
    // column list, and a bare select list raises 42P08. ON CONFLICT is enough on
    // its own: UQ_lookup_top is a unique index on (category, lower(value)).
    await queryRunner.query(
      `INSERT INTO "lookup_values" ("category","value","sort_order") VALUES ('gen',$1,$2)
       ON CONFLICT DO NOTHING`,
      ['None', 0],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only the value this migration added; the generations stay.
    await queryRunner.query(
      `DELETE FROM "lookup_values" WHERE "category" = 'gen' AND "value" = 'None'`,
    );
  }
}
