import { MigrationInterface, QueryRunner } from 'typeorm';

// Per-user permissions: adds users.permissions (text[]) and backfills it from
// the legacy role so that ON DEPLOY DAY NOBODY'S EFFECTIVE ACCESS CHANGES —
// each role's set reproduces exactly what that role could reach through the
// old @Roles decorators. Tightening (or widening) individuals is an admin
// edit from here on, not a code change.
//
// text[] rather than a Postgres enum: adding a permission later must be a code
// change plus a per-user grant, never another migration. The catalog of valid
// slugs lives in src/auth/permissions.ts; these arrays are a FROZEN COPY of
// that file's defaults at introduction time. Do not "fix" this migration to
// import from it — a migration must mean the same thing forever, while the
// catalog is expected to grow.
//
// The role column stays: role='admin' is the guard's master bypass, and
// role='manager' still drives lot ownership scoping (common/ownership.ts),
// which is a separate axis from permissions.
export class AddUserPermissions1752560000000 implements MigrationInterface {
  name = 'AddUserPermissions1752560000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN "permissions" text[] NOT NULL DEFAULT '{}'
    `);

    // Admin: every permission in the catalog. The guard bypasses grant checks
    // for role='admin' anyway; storing the full list keeps the user-management
    // checkboxes honest (an admin's row shows everything ticked).
    await queryRunner.query(`
      UPDATE "users" SET "permissions" = ARRAY[
        'dashboard','inventory','goods_in','amazon_audit','scan','assets',
        'pallets','consumables','sold','reports','activity','users',
        'perform_amazon_audit','perform_goods_in_audit','move_to_pallet',
        'create_batch','edit_batch','delete_batch','clear_manifest','export',
        'review_audits','sell_items','return_sold','delete_asset','delete_pallet',
        'merge_pallets','manage_ownership','manage_products','delete_product',
        'manage_consumables','delete_consumable','manage_sales','manage_photos',
        'add_lookup_values','manage_lookups'
      ]::text[] WHERE "role" = 'admin'
    `);

    await queryRunner.query(`
      UPDATE "users" SET "permissions" = ARRAY[
        'dashboard','inventory','goods_in','amazon_audit','scan','assets',
        'pallets','consumables','sold','reports','activity',
        'perform_amazon_audit','perform_goods_in_audit','move_to_pallet',
        'create_batch','edit_batch','clear_manifest','export','sell_items',
        'merge_pallets','manage_products','manage_consumables','manage_photos',
        'add_lookup_values'
      ]::text[] WHERE "role" = 'manager'
    `);

    await queryRunner.query(`
      UPDATE "users" SET "permissions" = ARRAY[
        'dashboard','inventory','goods_in','amazon_audit','scan','assets',
        'pallets','consumables',
        'perform_amazon_audit','perform_goods_in_audit','move_to_pallet',
        'create_batch','edit_batch','export','sell_items','add_lookup_values'
      ]::text[] WHERE "role" = 'technician'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "permissions"`);
  }
}
