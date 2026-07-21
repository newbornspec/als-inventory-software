// Mirrors apps/api/src/assets/asset.entity.ts and asset-audit.entity.ts enums.
export const STOCK_STATUSES = [
  'in_stock',
  'out_of_stock',
  'received',
  'awaiting_audit',
  'audited',
  'quarantined',
  'allocated',
  'picked',
  'packed',
  'shipped',
  'returned',
  'disposed',
];

export const CONDITION_GRADES = ['grade_a', 'grade_b', 'grade_c', 'grade_d', 'for_parts', 'scrap'];

// Sale tiers for pallet variant lines. Slugs so formatLabel renders "Tier 1" etc.
// Extend here (e.g. 'tier_3') without any schema change — the column is free text.
export const PALLET_TIERS = ['tier_1', 'tier_2'];

export const AUDIT_STATUSES = [
  'passed_testing',
  'failed_testing',
  'power_on',
  'no_power',
  'post_failed',
  'bios_locked',
  'missing_components',
  'data_wiped',
  'data_wipe_failed',
  'refurbished',
  'ready_for_sale',
  'repair_required',
  'ber',
];

export const DATA_WIPE_STATUSES = ['not_started', 'wiped', 'failed'];

export const FINAL_DISPOSITIONS = ['sell', 'repair', 'parts', 'recycle'];

export function formatLabel(value: string): string {
  if (value === 'ber') return 'Beyond Economic Repair (BER)';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
