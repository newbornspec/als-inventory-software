import type { Asset } from '@/lib/actions/assets';

// Where a device sits in the ITAD lifecycle.
//
// A DERIVED state, not a stored column: it reads a device's stock status and
// its audit verdict together. This mirrors LIFECYCLE_PREDICATES in the API's
// assets.service.ts — that one filters the tabs in SQL, this one paints the
// pill. They must agree, and an E2E check asserts it by requiring every row a
// tab returns to derive that tab's state.
//
// Precedence is the point: sold outranks everything (a sold device is SOLD
// whatever its verdict said), and quarantine outranks the verdict (a failed
// wipe is not merely "audited"). So the states partition the register.

export type Lifecycle =
  | 'in_processing'
  | 'audited'
  | 'wiped'
  | 'ready'
  | 'sold'
  | 'quarantine'
  // Left the building other than by sale — shipped or disposed. It has no tab
  // of its own (only All shows it), but it must never borrow a live state's
  // pill: a recycled machine that had been graded would otherwise read
  // "Ready", in green, as if it were sellable.
  | 'gone';

export function lifecycleOf(a: Pick<Asset, 'stockStatus' | 'auditStatus'>): Lifecycle {
  if (a.stockStatus === 'sold') return 'sold';
  if (a.stockStatus === 'shipped' || a.stockStatus === 'disposed') return 'gone';
  if (a.stockStatus === 'quarantined' || a.auditStatus === 'data_wipe_failed') return 'quarantine';
  if (a.auditStatus === 'ready_for_sale') return 'ready';
  if (a.auditStatus === 'data_wiped') return 'wiped';
  if (a.auditStatus) return 'audited';
  return 'in_processing';
}

// Tone carries meaning and never stands alone — the pill always prints its
// state in words beside the colour.
export const LIFECYCLE_STYLE: Record<Lifecycle, { label: string; pill: string; dot: string }> = {
  in_processing: {
    label: 'In processing',
    pill: 'border-neutral-300 bg-neutral-100 text-neutral-700',
    dot: 'bg-neutral-500',
  },
  audited: {
    label: 'Audited',
    pill: 'border-indigo-200 bg-indigo-50 text-indigo-800',
    dot: 'bg-indigo-500',
  },
  wiped: {
    label: 'Wiped',
    pill: 'border-blue-200 bg-blue-50 text-blue-800',
    dot: 'bg-blue-500',
  },
  ready: {
    label: 'Ready',
    pill: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    dot: 'bg-emerald-500',
  },
  sold: {
    label: 'Sold',
    pill: 'border-neutral-300 bg-neutral-100 text-neutral-600',
    dot: 'bg-neutral-400',
  },
  quarantine: {
    label: 'Quarantine',
    pill: 'border-red-200 bg-red-50 text-red-700',
    dot: 'bg-red-500',
  },
  // The page overrides this label with the device's actual stock status
  // ("Shipped" / "Disposed") — the state is real, it just has no tab.
  gone: {
    label: 'Gone',
    pill: 'border-neutral-300 bg-neutral-100 text-neutral-600',
    dot: 'bg-neutral-400',
  },
};

// The register's tabs, in lifecycle order. 'all' is a view, not a state — it
// is the only one that includes sold devices.
export const LIFECYCLE_TABS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in_processing', label: 'In processing' },
  { value: 'audited', label: 'Audited' },
  { value: 'wiped', label: 'Wiped' },
  { value: 'ready', label: 'Ready' },
  { value: 'sold', label: 'Sold' },
  { value: 'quarantine', label: 'Quarantine' },
];

// Saved views: the questions the floor actually asks, each one a real query.
// Every chip here maps to filters the API enforces — nothing is offered that
// the server cannot answer exactly.
export const SAVED_VIEWS: { label: string; params: Record<string, string>; hint: string }[] = [
  {
    label: 'Needs audit',
    params: { lifecycle: 'in_processing' },
    hint: 'Received, no audit verdict recorded yet',
  },
  {
    label: 'Needs wipe',
    params: { lifecycle: 'audited' },
    hint: 'Audited but not yet data-wiped',
  },
  {
    label: 'Wiped, not ready',
    params: { lifecycle: 'wiped' },
    hint: 'Data wiped, not yet marked ready for sale',
  },
  {
    label: 'Ready for pallet',
    params: { lifecycle: 'ready', onPallet: 'false' },
    hint: 'Ready for sale and not yet on a pallet',
  },
  { label: 'Ready for sale', params: { lifecycle: 'ready' }, hint: 'Graded and ready to sell' },
  {
    label: 'Failed wipe',
    params: { auditStatus: 'data_wipe_failed' },
    hint: 'Sanitisation failed — cannot be sold as-is',
  },
  {
    label: 'Missing serial',
    params: { noSerial: 'true' },
    hint: 'No serial recorded — unidentifiable on paper',
  },
  { label: 'Unallocated', params: { onPallet: 'false' }, hint: 'Not on any pallet' },
  {
    // The register is the only place a device with no lot can be found. The
    // grouped browse this page replaced had a "No lot" section; without this
    // chip that capability would have no entry point in the UI (only the
    // Inventory page's deep link).
    label: 'No lot',
    params: { noBatch: 'true' },
    hint: 'Not assigned to any Goods In lot',
  },
];
