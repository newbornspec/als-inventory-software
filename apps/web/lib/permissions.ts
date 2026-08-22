// Mirror of the API's permission catalog (apps/api/src/auth/permissions.ts) —
// keep the two in step when a permission is added. The API validates every
// submitted slug against its own list, so drift here shows up as a 400 on
// save, never as a silently-ignored grant.

export const MODULE_PERMISSIONS: { slug: string; label: string; hint: string }[] = [
  { slug: 'dashboard', label: 'Dashboard', hint: 'The operational start-of-shift view' },
  { slug: 'inventory', label: 'Inventory', hint: 'The stock roll-up across all three tiers' },
  { slug: 'goods_in', label: 'Goods In', hint: 'Receiving lots and reconciling manifests' },
  { slug: 'amazon_audit', label: 'Amazon Audit', hint: 'The dedicated audit workspace' },
  { slug: 'scan', label: 'Scan', hint: 'Barcode scanning and device lookup' },
  { slug: 'assets', label: 'Assets', hint: 'The serialized device register' },
  { slug: 'pallets', label: 'Pallets', hint: 'Pallet stock and exports' },
  { slug: 'consumables', label: 'Consumables', hint: 'Consumable stock levels' },
  { slug: 'sold', label: 'Sold', hint: 'The sold archive and customer records' },
  { slug: 'reports', label: 'Reports', hint: 'Business reports and exports' },
  { slug: 'activity', label: 'Activity', hint: 'The system-wide activity log' },
  { slug: 'users', label: 'Users', hint: 'Creating accounts and editing access' },
];

export const ACTION_PERMISSIONS: { slug: string; label: string; hint: string }[] = [
  { slug: 'perform_amazon_audit', label: 'Perform Amazon Audit', hint: 'Record hardware audits from the Audit Station' },
  { slug: 'perform_goods_in_audit', label: 'Perform Goods In Audit', hint: 'Record receiving audits on devices' },
  { slug: 'move_to_pallet', label: 'Move Items to Pallet', hint: 'Allocate Goods In items onto pallets' },
  { slug: 'create_batch', label: 'Create Goods In Batch', hint: 'Book in a new lot' },
  { slug: 'edit_batch', label: 'Edit Batch', hint: 'Change lot details, sub-lots and manifests' },
  { slug: 'delete_batch', label: 'Delete Batch', hint: 'Remove a lot and its structure' },
  { slug: 'clear_manifest', label: 'Clear Manifest', hint: "Delete a lot's expected line items" },
  { slug: 'export', label: 'Export', hint: 'Download xlsx, PDF and CSV reports' },
  { slug: 'review_audits', label: 'Review Audits', hint: 'Sign off recorded audits (workflow to come)' },
  { slug: 'sell_items', label: 'Sell Items', hint: 'Mark assets, lots or pallet lines as Sold' },
  { slug: 'return_sold', label: 'Return Sold Stock', hint: 'Bring sold stock back into inventory' },
  { slug: 'delete_asset', label: 'Delete Asset', hint: 'Remove a device and its history' },
  { slug: 'delete_pallet', label: 'Delete Pallet', hint: 'Remove a pallet' },
  { slug: 'merge_pallets', label: 'Merge Pallets', hint: 'Combine pallets into one' },
  { slug: 'manage_ownership', label: 'Manage Lot Ownership', hint: "Reassign a lot's owner" },
  { slug: 'manage_products', label: 'Manage Products', hint: 'Create and edit the product catalogue' },
  { slug: 'delete_product', label: 'Delete Product', hint: 'Remove a catalogue product' },
  { slug: 'manage_consumables', label: 'Manage Consumables', hint: 'Create, adjust and transfer consumable stock' },
  { slug: 'delete_consumable', label: 'Delete Consumable', hint: 'Remove a consumable line' },
  { slug: 'manage_sales', label: 'Manage Sales Records', hint: 'Delete legacy orders and customers' },
  { slug: 'manage_photos', label: 'Manage Photos', hint: 'Delete asset photos' },
  { slug: 'add_lookup_values', label: 'Add Lookup Values', hint: 'Add dropdown options inline from forms' },
  { slug: 'manage_lookups', label: 'Manage Lookups', hint: 'Edit and remove dropdown options' },
];

const ALL_SLUGS = [...MODULE_PERMISSIONS, ...ACTION_PERMISSIONS].map((p) => p.slug);

const TECHNICIAN_DEFAULTS = [
  'dashboard', 'inventory', 'goods_in', 'amazon_audit', 'scan', 'assets',
  'pallets', 'consumables',
  'perform_amazon_audit', 'perform_goods_in_audit', 'move_to_pallet',
  'create_batch', 'edit_batch', 'export', 'sell_items', 'add_lookup_values',
];

const MANAGER_DEFAULTS = [
  ...TECHNICIAN_DEFAULTS,
  'sold', 'reports', 'activity',
  'clear_manifest', 'merge_pallets', 'manage_products', 'manage_consumables',
  'manage_photos',
];

export const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  admin: ALL_SLUGS,
  manager: MANAGER_DEFAULTS,
  technician: TECHNICIAN_DEFAULTS,
};

// ---------------------------------------------------------------------------
// Routing: which module permission opens which area, and where a user lands.
// UI-gating only — the API enforces access on every call regardless.
// ---------------------------------------------------------------------------

export interface SessionAccess {
  userId: string;
  role: string;
  permissions: string[];
}

// Landing priority order: a single-module user lands on their module; a
// multi-module user without the dashboard lands on the first entry they hold.
export const MODULE_ROUTES: { permission: string; href: string }[] = [
  { permission: 'dashboard', href: '/dashboard' },
  { permission: 'goods_in', href: '/batches' },
  { permission: 'amazon_audit', href: '/audit' },
  { permission: 'inventory', href: '/inventory' },
  { permission: 'scan', href: '/scan' },
  { permission: 'assets', href: '/assets' },
  { permission: 'pallets', href: '/pallets' },
  { permission: 'consumables', href: '/stock' },
  { permission: 'sold', href: '/sold' },
  { permission: 'reports', href: '/reports' },
  { permission: 'activity', href: '/activity' },
  { permission: 'users', href: '/users' },
];

// Route prefix -> the permission that opens it, for validating a ?from= deep
// link before honouring it. Prefixes not listed are never honoured.
const PATH_PERMISSIONS: [string, string][] = [
  ...MODULE_ROUTES.map(({ href, permission }) => [href, permission] as [string, string]),
  ['/lookups', 'manage_lookups'],
  ['/sell', 'sold'], // same audience as the Sold archive (the page says so)
  ['/transfer', 'manage_consumables'], // same audience as adjusting stock
];

export function hasPermission(access: SessionAccess | null, permission: string): boolean {
  if (!access) return false;
  // Admin bypass mirrors the API guard: role is the master switch, so a
  // damaged grant list can never hide the screens that repair grant lists.
  return access.role === 'admin' || access.permissions.includes(permission);
}

// May this user open this path? Only says yes for paths it can vouch for.
export function mayVisit(path: string, access: SessionAccess | null): boolean {
  const hit = PATH_PERMISSIONS.find(([prefix]) => path.startsWith(prefix));
  return hit ? hasPermission(access, hit[1]) : false;
}

// Where a signed-in user lands: the spec's rule is that a user with exactly
// one module goes straight to it. With several, dashboard wins when held,
// else the first module they hold in priority order. With none, a plain
// explainer page rather than a redirect loop.
export function landingFor(access: SessionAccess | null): string {
  if (!access) return '/dashboard';
  if (access.role === 'admin') return '/dashboard';
  const held = MODULE_ROUTES.filter(({ permission }) =>
    access.permissions.includes(permission),
  );
  if (held.length === 0) return '/no-access';
  if (held.length === 1) return held[0].href;
  const dashboard = held.find((m) => m.permission === 'dashboard');
  return (dashboard ?? held[0]).href;
}
