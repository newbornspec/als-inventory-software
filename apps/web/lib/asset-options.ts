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
  // Terminal Sold status. Filtering by it is the only way sold assets appear
  // in the Assets search (they're excluded from all active views by default).
  'sold',
];

export const CONDITION_GRADES = ['grade_a', 'grade_b', 'grade_c', 'grade_d', 'for_parts', 'scrap'];

// What a pallet line's Grade dropdown OFFERS. Deliberately narrower than
// CONDITION_GRADES: pallet stock is graded A-D, and for_parts/scrap are
// serialized-asset dispositions. Lines created before this still hold those
// values and must keep them — the editor appends a row's own grade when it is
// not in this list, or the select would render blank and save that blank.
export const PALLET_LINE_GRADES = ['grade_a', 'grade_b', 'grade_c', 'grade_d'];

// Monitor bezel style. Two values, so a const rather than a lookup category.
// Mirrors PALLET_VARIANT_TYPES in the API's create-pallet-line.dto.ts.
export const PALLET_VARIANT_TYPES = ['normal', 'frameless'];

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
