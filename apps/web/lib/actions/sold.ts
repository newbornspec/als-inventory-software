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

export async function sellAsset(id: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/assets/${id}/sell`, { method: 'POST', body: JSON.stringify({}) });
  } catch (err) {
    return { error: msg(err, 'Failed to mark as sold.') };
  }
  revalidatePath(`/assets/${id}`);
  revalidateInventory();
  return {};
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
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/pallets/${palletId}/lines/${lineId}/sell`, {
      method: 'POST',
      body: JSON.stringify(quantity ? { quantity } : {}),
    });
  } catch (err) {
    return { error: msg(err, 'Failed to sell that line.') };
  }
  revalidatePath(`/pallets/${palletId}`);
  revalidateInventory();
  return {};
}

export async function sellWholePallet(palletId: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/pallets/${palletId}/sell`, { method: 'POST', body: JSON.stringify({}) });
  } catch (err) {
    return { error: msg(err, 'Failed to sell the pallet.') };
  }
  revalidatePath(`/pallets/${palletId}`);
  revalidateInventory();
  return {};
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
