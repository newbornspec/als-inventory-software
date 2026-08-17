import { MigrationInterface, QueryRunner } from 'typeorm';

// Pallet numbers become operator-entered. The warehouse writes a number on the
// physical pallet before it reaches a keyboard, so the system has to accept that
// number rather than invent a competing one.
//
// The sequence STAYS. It is now the suggested default that prefills the form and
// the fallback when the field is left blank — Layout 2 creates its pallet the
// instant a layout is picked, with no chance to ask for a number. Dropping the
// sequence would also make this release irreversible: a rollback would leave
// pallet creation with no number source at all.
//
// The existing UNIQUE constraint is case-sensitive and does not stop whitespace
// variants, which did not matter while every number was machine-generated and
// zero-padded. Once they are typed, "P1", "p1" and " P1 " are three different
// pallets to Postgres and one pallet to a human.
export class UserEnteredPalletNumber1752460000000 implements MigrationInterface {
  name = 'UserEnteredPalletNumber1752460000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Normalise what is already there, so the index below can be created. These
    // are no-ops on generated numbers, which never had stray whitespace.
    await queryRunner.query(
      `UPDATE "pallets" SET "pallet_number" = TRIM("pallet_number")
       WHERE "pallet_number" <> TRIM("pallet_number")`,
    );

    // Fails loudly if two existing pallets differ only by case or whitespace.
    // That is the correct outcome: it needs a human decision about which pallet
    // keeps the number, not a migration silently picking one.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pallets_pallet_number_ci"
       ON "pallets" (LOWER(TRIM("pallet_number")))`,
    );

    // Keep the sequence ahead of anything typed by hand, so a blank field never
    // suggests a number that is already on a pallet. setval with is_called=true
    // means the NEXT nextval returns one past the highest existing number.
    await queryRunner.query(`
      SELECT setval(
        'pallet_number_seq',
        GREATEST(
          (SELECT last_value FROM "pallet_number_seq"),
          COALESCE((
            SELECT MAX(SUBSTRING("pallet_number" FROM '^PALLET-0*([0-9]+)$')::bigint)
            FROM "pallets"
            WHERE "pallet_number" ~ '^PALLET-0*[0-9]+$'
          ), 0)
        ),
        true
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_pallets_pallet_number_ci"`);
  }
}
