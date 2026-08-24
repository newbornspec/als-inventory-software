// Shared lookup types and constants.
//
// These live OUTSIDE lib/actions/lookups.ts on purpose. That file is marked
// `'use server'`, and Next allows such a module to export nothing but async
// functions — exporting the LOOKUP_CATEGORIES array from it threw
//
//   Error: A "use server" file can only export async functions, found object.
//
// at module load, which meant every write the Lookups screen makes (add,
// rename, enable/disable, delete) returned a 500 and blanked the page. The
// build never caught it because the rule is enforced at runtime.

export interface LookupValue {
  id: string;
  category: string;
  value: string;
  parentId: string | null;
  active: boolean;
  sortOrder: number;
}

// Must match LOOKUP_CATEGORIES in the API's lookup-value.entity.ts. 'gen' was
// missing here once, so the admin screen could not manage it.
export const LOOKUP_CATEGORIES = [
  'manufacturer',
  'model',
  'chassis',
  'cpu',
  'gen',
  'ram',
  'storage',
  'size',
] as const;

export type LookupCategory = (typeof LOOKUP_CATEGORIES)[number];
