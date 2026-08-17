import { MigrationInterface, QueryRunner } from 'typeorm';

// Layout 1 pallet lines become one row per product/variant combination, matching
// the spreadsheet the warehouse already keeps by hand:
//   Pallet | Manufacturer | Model | Size | Variant | Stand | Qty | Grade | Unit cost | Line total
//
// Quantity, grade and unit_cost already exist. This adds the five that don't.
// Line total is never stored — it is quantity x unit_cost, computed wherever it
// is shown, so it cannot drift out of step with its inputs.
//
// `variant` is deliberately NOT touched. It is NOT NULL and load-bearing: the
// Layout-1 report row, the Layout-2 column fallback, the sold snapshot and
// sold-return matching all read it. It becomes a server-composed display label;
// the new Normal/Frameless field is `variant_type`.
//
// Every column is nullable with no default. Railway runs migrations BEFORE the
// new code is live, so the old code keeps inserting rows without these columns
// during the deploy window — a NOT NULL column would break every insert until
// the deploy finished. Same reasoning as 1752430000000-AddAssetUnitId.
export class AddPalletLineSpecColumns1752450000000 implements MigrationInterface {
  name = 'AddPalletLineSpecColumns1752450000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [col, type] of [
      ['manufacturer', 'character varying'],
      ['model', 'character varying'],
      ['size', 'character varying'],
      // Named variant_type because `variant` is taken. Slug ('normal' /
      // 'frameless'); the web renders it through formatLabel like every other
      // slug in the app.
      ['variant_type', 'character varying'],
      // Three-state by nullability: true = Yes, false = No, NULL = not recorded.
      // Every pre-existing row is NULL, which is honest — we do not know whether
      // those monitors shipped with a stand, and guessing would invent data.
      ['stand', 'boolean'],
    ]) {
      await queryRunner.query(
        `ALTER TABLE "pallet_lines" ADD COLUMN IF NOT EXISTS "${col}" ${type}`,
      );
    }

    // Lines built with Layout 2 already link a catalogue product carrying these
    // exact values, so lift them across rather than making the operator retype
    // what the system already knows. Guarded on all three being NULL so a re-run
    // can never overwrite something entered by hand.
    await queryRunner.query(`
      UPDATE "pallet_lines" l
      SET "manufacturer" = p."manufacturer",
          "model"        = p."model",
          "size"         = p."screen_size"
      FROM "products" p
      WHERE p."id" = l."product_id"
        AND l."manufacturer" IS NULL
        AND l."model" IS NULL
        AND l."size" IS NULL
    `);

    // ---- Lookup seeds -------------------------------------------------------
    // Dell, HP, Lenovo and Samsung are already seeded by
    // 1752360000000-CreateLookupValues. These are the rest of the list the
    // warehouse uses. "Tier 1"/"Tier 2"/"Mixed" are not manufacturers, but they
    // are what the operator picks in that column on the real sheet, and the
    // lookup table exists precisely so the business can shape its own lists.
    const seed = async (category: string, values: string[], from = 0) => {
      for (let i = 0; i < values.length; i++) {
        await queryRunner.query(
          `INSERT INTO "lookup_values" ("category","value","sort_order")
           SELECT $1,$2,$3
           WHERE NOT EXISTS (
             SELECT 1 FROM "lookup_values"
             WHERE "category" = $1 AND LOWER("value") = LOWER($2)
           )`,
          [category, values[i], from + i],
        );
      }
    };

    await seed('manufacturer', ['Iiyama', 'Philips', 'BenQ', 'AOC', 'Tier 1', 'Tier 2', 'Mixed'], 100);

    // Monitor sizes, in the order they should appear. 19/20 is a single entry
    // because the warehouse groups those two together on the sheet.
    const sizes = ['19/20"'];
    for (let n = 21; n <= 32; n++) sizes.push(`${n}"`);
    sizes.push('34"', '38"', '40"', '43"', '49"', '50"', '55"', '65"');
    await seed('size', sizes);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const col of ['manufacturer', 'model', 'size', 'variant_type', 'stand']) {
      await queryRunner.query(`ALTER TABLE "pallet_lines" DROP COLUMN IF EXISTS "${col}"`);
    }
    // Only the values this migration seeded; the originals stay.
    await queryRunner.query(`DELETE FROM "lookup_values" WHERE "category" = 'size'`);
    await queryRunner.query(
      `DELETE FROM "lookup_values"
       WHERE "category" = 'manufacturer'
         AND "value" IN ('Iiyama','Philips','BenQ','AOC','Tier 1','Tier 2','Mixed')`,
    );
  }
}
