'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { ActionState } from './assets';

export type PalletStatus = 'open' | 'ready' | 'shipped';

export interface PalletLine {
  id: string;
  palletId: string;
  variant: string;
  supplier: string | null;
  quantity: number;
  unitCost: number | null;
  productId: string | null;
  createdAt: string;
}

export interface Pallet {
  id: string;
  palletNumber: string;
  description: string | null;
  supplier: string | null;
  locationId: string | null;
  status: PalletStatus;
  notes: string | null;
  shippedAt: string | null;
  totalQuantity: number;
  lineCount: number;
  location?: { id: string; name: string } | null;
  lines?: PalletLine[];
}

export async function createPallet(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const dto = {
    description: str(formData.get('description')),
    supplier: str(formData.get('supplier')),
    locationId: str(formData.get('locationId')),
    notes: str(formData.get('notes')),
  };
  let created: Pallet;
  try {
    created = await apiFetch<Pallet>('/pallets', { method: 'POST', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create pallet.' };
  }
  revalidatePath('/pallets');
  redirect(`/pallets/${created.id}`);
}

export async function updatePalletStatus(id: string, formData: FormData): Promise<void> {
  const status = String(formData.get('status') ?? '');
  await apiFetch(`/pallets/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  revalidatePath(`/pallets/${id}`);
  revalidatePath('/pallets');
}

export async function updatePalletSupplier(id: string, formData: FormData): Promise<void> {
  const supplier = String(formData.get('supplier') ?? '').trim();
  await apiFetch(`/pallets/${id}`, { method: 'PATCH', body: JSON.stringify({ supplier }) });
  revalidatePath(`/pallets/${id}`);
  revalidatePath('/pallets');
}

export async function deletePallet(id: string): Promise<void> {
  try {
    await apiFetch(`/pallets/${id}`, { method: 'DELETE' });
  } catch (err) {
    // Already deleted (e.g. double-click, or removed in another tab)? The goal
    // is already met — go to the list rather than crashing. Re-throw anything else.
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  revalidatePath('/pallets');
  redirect('/pallets');
}

export async function addPalletLine(
  palletId: string,
  variant: string,
  quantity: number,
  unitCost: number | null,
  supplier: string,
): Promise<{ error?: string }> {
  const v = variant.trim();
  if (!v) return { error: 'Variant is required.' };
  try {
    await apiFetch(`/pallets/${palletId}/lines`, {
      method: 'POST',
      body: JSON.stringify({
        variant: v,
        supplier: supplier.trim() || undefined,
        quantity: Math.max(0, Math.trunc(quantity) || 0),
        unitCost: unitCost ?? undefined,
      }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to add line.' };
  }
  revalidatePath(`/pallets/${palletId}`);
  revalidatePath('/pallets');
  return {};
}

export async function updatePalletLine(
  palletId: string,
  lineId: string,
  variant: string,
  quantity: number,
  unitCost: number | null,
  supplier: string,
): Promise<void> {
  await apiFetch(`/pallets/${palletId}/lines/${lineId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      variant: variant.trim(),
      supplier: supplier.trim(),
      quantity: Math.max(0, Math.trunc(quantity) || 0),
      unitCost: unitCost ?? undefined,
    }),
  });
  revalidatePath(`/pallets/${palletId}`);
  revalidatePath('/pallets');
}

export async function deletePalletLine(palletId: string, lineId: string): Promise<void> {
  await apiFetch(`/pallets/${palletId}/lines/${lineId}`, { method: 'DELETE' });
  revalidatePath(`/pallets/${palletId}`);
  revalidatePath('/pallets');
}

function str(value: FormDataEntryValue | null): string | undefined {
  const s = String(value ?? '').trim();
  return s === '' ? undefined : s;
}
