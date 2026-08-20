'use server';

import { apiFetch, ApiError } from '@/lib/api-server';
import type { Asset } from '@/lib/actions/assets';

export interface Sellable {
  id: string;
  tag: string;
  name: string;
  stockStatus: string;
  location: string | null;
}

// Find a device to sell. GET /assets already excludes sold devices from every
// list unless a status filter asks for them, so anything returned here is still
// sellable — no extra guard needed, and a device sold five minutes ago simply
// will not appear.
export async function findSellable(
  query: string,
): Promise<{ matches?: Sellable[]; error?: string }> {
  const q = query.trim();
  if (!q) return { matches: [] };

  try {
    const rows = await apiFetch<Asset[]>(`/assets?search=${encodeURIComponent(q)}`);
    // An exact tag or unit id wins outright — that is a scanner, and offering a
    // list of near-matches after a successful scan is just friction.
    const exact = rows.filter((a) => a.tag === q || a.unitId === q);
    const use = exact.length > 0 ? exact : rows;
    return {
      matches: use.slice(0, 25).map((a) => ({
        id: a.id,
        tag: a.tag,
        name: a.name,
        stockStatus: a.stockStatus,
        location: a.location?.name ?? null,
      })),
    };
  } catch (err) {
    return {
      error: err instanceof ApiError ? err.message : 'Could not search for that device.',
    };
  }
}
