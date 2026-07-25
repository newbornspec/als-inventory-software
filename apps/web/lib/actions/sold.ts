'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';

// The Sold workflow: selling locks an item out of active inventory; only an
// admin can return it (the API enforces both — these are thin wrappers).

export interface SoldAsset {
  id: string;
  name: string;
  tag: string;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  soldAt: string | null;
  batch?: { id: string; batchNumber: string } | null;
  lot?: { id: string; lotNumber: string } | null;
  product?: { manufacturer: string | null; model: string | null } | null;
  soldBy?: { id: string; name: string } | null;
}

export interface SoldPalletLine {
  id: string;
  palletId: string | null;
  palletNumber: string;
  variant: string;
  quantity: number;
  soldAt: string;
  soldBy?: { id: string; name: string } | null;
  product?: {
    manufacturer: string | null;
    model: string | null;
    chassis: string | null;
    cpu: string | null;
    gen: string | null;
    ramGb: number | null;
    storage: string | null;
  } | null;
}

function msg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function revalidateInventory(): void {
  for (const p of ['/sold', '/assets', '/batches', '/pallets', '/inventory', '/reports']) {
    revalidatePath(p);
  }
}

export async function sellAsset(id: string, salePrice?: number): Promise<{ error?: string }> {
  try {
    await apiFetch(`/assets/${id}/sell`, {
      method: 'POST',
      body: JSON.stringify(salePrice != null ? { salePrice } : {}),
    });
  } catch (err) {
    return { error: msg(err, 'Failed to mark as sold.') };
  }
  revalidatePath(`/assets/${id}`);
  revalidateInventory();
  return {};
}

// Sell a whole lot: every remaining device in it is marked Sold and the lot's
// status becomes 'sold'.
export async function sellBatch(
  id: string,
  saleTotal?: number,
): Promise<{ soldCount?: number; error?: string }> {
  let res: { soldCount: number };
  try {
    res = await apiFetch<{ soldCount: number }>(`/batches/${id}/sell`, {
      method: 'POST',
      body: JSON.stringify(saleTotal != null ? { saleTotal } : {}),
    });
  } catch (err) {
    return { error: msg(err, 'Failed to sell the lot.') };
  }
  revalidatePath(`/batches/${id}`);
  revalidateInventory();
  return { soldCount: res.soldCount };
}

export async function returnSoldAsset(
  id: string,
  batchId: string | null,
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/assets/${id}/return`, {
      method: 'POST',
      body: JSON.stringify({ batchId }),
    });
  } catch (err) {
    return { error: msg(err, 'Failed to return the asset.') };
  }
  revalidatePath(`/assets/${id}`);
  revalidateInventory();
  return {};
}

export async function sellPalletLine(
  palletId: string,
  lineId: string,
  quantity?: number,
  salePrice?: number,
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/pallets/${palletId}/lines/${lineId}/sell`, {
      method: 'POST',
      body: JSON.stringify({
        ...(quantity ? { quantity } : {}),
        ...(salePrice != null ? { salePrice } : {}),
      }),
    });
  } catch (err) {
    return { error: msg(err, 'Failed to sell that line.') };
  }
  revalidatePath(`/pallets/${palletId}`);
  revalidateInventory();
  return {};
}

export async function sellWholePallet(
  palletId: string,
  saleTotal?: number,
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/pallets/${palletId}/sell`, {
      method: 'POST',
      body: JSON.stringify(saleTotal != null ? { saleTotal } : {}),
    });
  } catch (err) {
    return { error: msg(err, 'Failed to sell the pallet.') };
  }
  revalidatePath(`/pallets/${palletId}`);
  revalidateInventory();
  return {};
}

// Bulk return of sold assets. batchId omitted -> each returns to its own
// original lot; set -> all go to that lot.
export async function bulkReturnSoldAssets(
  assetIds: string[],
  batchId?: string,
): Promise<{ returned?: number; skipped?: number; error?: string }> {
  let res: { returned: number; skipped: number };
  try {
    res = await apiFetch<{ returned: number; skipped: number }>('/assets/sold/return-bulk', {
      method: 'POST',
      body: JSON.stringify({ assetIds, ...(batchId ? { batchId } : {}) }),
    });
  } catch (err) {
    return { error: msg(err, 'Failed to return the selected items.') };
  }
  revalidateInventory();
  return res;
}

// Bulk return of sold pallet quantities. palletId omitted -> each returns to
// its own original pallet.
export async function bulkReturnSoldPalletLines(
  soldIds: string[],
  palletId?: string,
): Promise<{ returned?: number; skipped?: number; error?: string }> {
  let res: { returned: number; skipped: number };
  try {
    res = await apiFetch<{ returned: number; skipped: number }>('/pallets/sold/return-bulk', {
      method: 'POST',
      body: JSON.stringify({ soldIds, ...(palletId ? { palletId } : {}) }),
    });
  } catch (err) {
    return { error: msg(err, 'Failed to return the selected items.') };
  }
  revalidateInventory();
  return res;
}

export async function returnSoldPalletLine(
  soldId: string,
  palletId: string | null,
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/pallets/sold/${soldId}/return`, {
      method: 'POST',
      body: JSON.stringify({ palletId }),
    });
  } catch (err) {
    return { error: msg(err, 'Failed to return to inventory.') };
  }
  revalidateInventory();
  return {};
}
