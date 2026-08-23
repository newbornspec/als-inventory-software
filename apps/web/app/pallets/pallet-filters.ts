import type { Pallet } from '@/lib/actions/pallets';

// Layout is stored as the entry mode that created the pallet. The UI calls them
// Layout 1 and Layout 2 because that is what the New Pallet chooser calls them;
// the stored values are older and stay as they are.
export const LAYOUT_LABEL: Record<string, string> = {
  variant: 'Layout 1',
  spec: 'Layout 2',
  // Device-holding pallets (entry_layout='asset'). Falling through to
  // 'Layout 1' mislabeled every serialized pallet in the list.
  asset: 'Serialized',
};

export function layoutLabel(entryLayout?: string): string {
  return LAYOUT_LABEL[entryLayout ?? 'variant'] ?? 'Layout 1';
}

export type DatePreset =
  | 'any'
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'thisMonth'
  | 'lastMonth'
  | 'custom';

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'any', label: 'Any date' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'custom', label: 'Custom range' },
];

export interface PalletFilterState {
  search: string;
  preset: DatePreset;
  from: string; // yyyy-mm-dd, only meaningful when preset === 'custom'
  to: string;
  layout: string; // '' = all
  // Multi-select: a warehouse question is usually "everything still workable"
  // (Open + Ready together), which a single-select can't ask. [] = all.
  statuses: string[];
  location: string;
  supplier: string;
}

export const EMPTY_FILTERS: PalletFilterState = {
  search: '',
  preset: 'any',
  from: '',
  to: '',
  layout: '',
  statuses: [],
  location: '',
  supplier: '',
};

// Half-open [start, end): the end is the first instant NOT included, so a range
// ending "today" covers everything up to midnight tonight without depending on
// how precise the timestamp is.
function presetRange(preset: DatePreset, from: string, to: string): [number, number] | null {
  const now = new Date();
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = midnight(now);
  const DAY = 86_400_000;

  switch (preset) {
    case 'today':
      return [today, today + DAY];
    case 'yesterday':
      return [today - DAY, today];
    case 'last7':
      return [today - 6 * DAY, today + DAY];
    case 'last30':
      return [today - 29 * DAY, today + DAY];
    case 'thisMonth':
      return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), today + DAY];
    case 'lastMonth':
      return [
        new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(),
        new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      ];
    case 'custom': {
      if (!from && !to) return null;
      const start = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
      // Inclusive of the "to" day, which is what a person means by a date range.
      const end = to ? new Date(`${to}T00:00:00`).getTime() + DAY : Infinity;
      return [start, end];
    }
    default:
      return null;
  }
}

export function countActiveFilters(f: PalletFilterState): number {
  let n = 0;
  if (f.search.trim()) n += 1;
  if (f.preset !== 'any') n += 1;
  if (f.layout) n += 1;
  if (f.statuses.length > 0) n += 1;
  if (f.location) n += 1;
  if (f.supplier) n += 1;
  return n;
}

// Search spans everything a person might have in their head when looking for a
// pallet: its number, what is on it, who it came from, where it is, and its
// state. Matching is case-insensitive and substring, so "000095" finds
// PALLET-000095 without typing the prefix.
function matchesSearch(p: Pallet, q: string): boolean {
  const hay = [
    p.palletNumber,
    p.description ?? '',
    p.supplier ?? '',
    p.location?.name ?? '',
    p.status,
    layoutLabel(p.entryLayout),
  ]
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

export function applyFilters(pallets: Pallet[], f: PalletFilterState): Pallet[] {
  const range = presetRange(f.preset, f.from, f.to);
  const q = f.search.trim();

  return pallets.filter((p) => {
    if (q && !matchesSearch(p, q)) return false;
    if (f.layout && (p.entryLayout ?? 'variant') !== f.layout) return false;
    if (f.statuses.length > 0 && !f.statuses.includes(p.status)) return false;
    if (f.location && (p.location?.id ?? '') !== f.location) return false;
    if (f.supplier && (p.supplier ?? '') !== f.supplier) return false;
    if (range) {
      const t = new Date(p.createdAt).getTime();
      if (Number.isNaN(t) || t < range[0] || t >= range[1]) return false;
    }
    return true;
  });
}

export type SortKey = 'created' | 'palletNumber' | 'units';
export type SortDir = 'asc' | 'desc';

export function sortPallets(pallets: Pallet[], key: SortKey, dir: SortDir): Pallet[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...pallets].sort((a, b) => {
    switch (key) {
      case 'palletNumber':
        return a.palletNumber.localeCompare(b.palletNumber) * sign;
      case 'units':
        return ((a.totalQuantity ?? 0) - (b.totalQuantity ?? 0)) * sign;
      default:
        return (
          (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * sign
        );
    }
  });
}

// Mirrors MAX_EXPORT_PALLETS in the API's pallets.service.ts. Duplicated rather
// than shared because the two apps deploy separately; the server is the one
// that enforces it, and this only exists so the button can explain itself
// BEFORE the operator loses the page to an error screen.
export const MAX_EXPORT_PALLETS = 500;
