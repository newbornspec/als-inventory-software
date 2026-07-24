import { MigrationInterface, QueryRunner } from 'typeorm';

// Layout 2 gains a Gen (CPU generation) column between CPU and RAM. Additive:
// a nullable products.gen column for dedup/reporting, plus seeded 'gen' lookup
// values (1st Gen … 14th Gen) for the searchable dropdown.
export class AddProductGenAndGenLookups1752390000000 implements MigrationInterface {
  name = 'AddProductGenAndGenLookups1752390000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "gen" character varying`,
    );

    const gens = [
      '1st Gen', '2nd Gen', '3rd Gen', '4th Gen', '5th Gen', '6th Gen', '7th Gen',
      '8th Gen', '9th Gen', '10th Gen', '11th Gen', '12th Gen', '13th Gen', '14th Gen',
    ];
    for (let i = 0; i < gens.length; i++) {
      await queryRunner.query(
        `INSERT INTO "lookup_values" ("category","value","sort_order") VALUES ('gen',$1,$2)
         ON CONFLICT DO NOTHING`,
        [gens[i], i],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "lookup_values" WHERE "category" = 'gen'`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "gen"`);
  }
}
