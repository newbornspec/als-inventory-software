// The permission catalog — the single source of truth for what access can be
// granted. Authorization is per-user grants from this list (users.permissions,
// a text[] column), replacing decisions hardwired to the three-role enum.
//
// Two kinds, mirroring the client spec's user-management screen:
//   MODULE permissions — which areas of the app a user can reach at all.
//   ACTION permissions — specific things a user may do, independent of which
//   modules they hold (e.g. a Goods In user with or without "Move to Pallet").
//
// Extending: add the slug here and reference it from a @RequirePermissions()
// decorator. The column is text[], NOT a Postgres enum, precisely so that a new
// permission is a code change and a per-user grant — never a schema migration.
//
// Renaming/removing is NOT free: slugs are stored in users.permissions rows, so
// that takes a data migration.
//
// The role column remains, with exactly two jobs left:
//   - role='admin' is the master switch — PermissionsGuard lets admins through
//     without consulting grants, so a broken grant list can never lock out the
//     account that repairs grant lists;
//   - role='manager' still drives lot OWNERSHIP scoping (common/ownership.ts),
//     which is a separate axis: permissions decide WHAT you can do, ownership
//     decides WHICH lots you can do it to.

export const MODULE_PERMISSIONS = [
  'dashboard',
  'inventory',
  'goods_in', // the /batches area — receiving/staging
  'amazon_audit', // the /audit workspace (page ships later; grants exist now)
  'scan',
  'assets',
  'pallets',
  'consumables', // the /stock area
  'sold',
  'reports',
  'activity',
  'users', // user management — implies seeing and editing grants
] as const;

export const ACTION_PERMISSIONS = [
  'perform_amazon_audit',
  'perform_goods_in_audit',
  'move_to_pallet', // no consumer yet — enforced when Goods In allocation ships
  'create_batch',
  'edit_batch', // also covers sub-lots and manifest imports (batch structure)
  'delete_batch', // also sub-lot deletion
  'clear_manifest', // deleting a batch's expected/manifest lines
  'export', // xlsx/pdf/csv downloads
  'review_audits', // no consumer yet — the audit sign-off workflow, when specced
  'sell_items', // marking assets/batches/pallet lines Sold
  'return_sold', // admin-grade: bringing sold stock back into inventory
  // Admin-grade per the client's §11: once devices are transferred to a
  // pallet, normal users cannot move them back — the pallet is their current
  // owner. Deliberately in NO default set below; admins pass via role bypass.
  'return_from_pallet',
  'delete_asset',
  'delete_pallet',
  'merge_pallets',
  'manage_ownership', // reassigning a lot's owner
  'manage_products', // create/edit the product catalogue
  'delete_product',
  'manage_consumables', // create/edit/adjust/transfer consumable stock
  'delete_consumable',
  'manage_sales', // legacy orders/customers deletion (module removed from UI)
  'manage_photos', // deleting asset photos (upload is open to asset holders)
  'add_lookup_values', // adding dropdown values inline from forms
  'manage_lookups', // editing/removing lookup values (the admin Lookups page)
] as const;

export const ALL_PERMISSIONS = [...MODULE_PERMISSIONS, ...ACTION_PERMISSIONS] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

// What each legacy role could actually reach on the day permissions shipped —
// the deploy-day invariant is that backfilling these sets changes NOBODY's
// effective access. Deliberately keyed by plain strings, not the UserRole
// enum: user.entity.ts types its permissions column against this file, and
// importing the entity here would be a cycle.
//
// The migration (1752560000000-AddUserPermissions) carries a frozen copy of
// these arrays: the migration must never change meaning after it has run,
// while this map is expected to evolve.
const TECHNICIAN_DEFAULTS: Permission[] = [
  'dashboard',
  'inventory',
  'goods_in',
  'amazon_audit',
  'scan',
  'assets',
  'pallets',
  'consumables',
  'perform_amazon_audit',
  'perform_goods_in_audit',
  'move_to_pallet',
  'create_batch',
  'edit_batch',
  'export',
  'sell_items',
  'add_lookup_values',
];

const MANAGER_DEFAULTS: Permission[] = [
  ...TECHNICIAN_DEFAULTS,
  'sold',
  'reports',
  'activity',
  'clear_manifest',
  'merge_pallets',
  'manage_products',
  'manage_consumables',
  'manage_photos',
];

export const DEFAULT_PERMISSIONS: Record<'admin' | 'manager' | 'technician', Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  manager: MANAGER_DEFAULTS,
  technician: TECHNICIAN_DEFAULTS,
};
