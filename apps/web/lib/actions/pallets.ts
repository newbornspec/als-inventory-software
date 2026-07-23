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
  tier: string | null;
  quantity: number;
  grade: string | null;
  unitCost: number | null;
  productId: string | null;
  createdAt: string;
}

export interface Pallet {
  id: string;
  palletNumber: string;
  description: string | null;
  supplier: string | null;
  buyer: string | null;
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
    buyer: str(formData.get('buyer')),
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

export interface SpecRow {
  manufacturer?: string;
  model?: string;
  chassis?: string;
  cpu?: string;
  ram?: string;
  storage?: string;
  quantity: number;
}

// Layout 2: create a pallet + all its lines from the spec table in one call.
// Returns the new pallet id so the client can navigate (kept as a return, not a
// redirect, so validation errors can be shown in the grid).
export async function createPalletFromSpec(input: {
  description?: string;
  supplier?: string;
  buyer?: string;
  locationId?: string;
  notes?: string;
  rows: SpecRow[];
}): Promise<{ id?: string; error?: string }> {
  const rows = input.rows
    .filter((r) => [r.manufacturer, r.model, r.chassis, r.cpu, r.ram, r.storage].some((v) => v?.trim()) || r.quantity > 0)
    .map((r) => ({ ...r, quantity: Math.max(0, Math.trunc(r.quantity) || 0) }));
  if (rows.length === 0) return { error: 'Add at least one row.' };
  const clean = (s?: string) => (s && s.trim() ? s.trim() : undefined);
  try {
    const created = await apiFetch<Pallet>('/pallets/spec', {
      method: 'POST',
      body: JSON.stringify({
        description: clean(input.description),
        supplier: clean(input.supplier),
        buyer: clean(input.buyer),
        locationId: clean(input.locationId),
        notes: clean(input.notes),
        rows,
      }),
    });
    revalidatePath('/pallets');
    return { id: created.id };
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create pallet.' };
  }
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

export async function updatePalletBuyer(id: string, formData: FormData): Promise<void> {
  const buyer = String(formData.get('buyer') ?? '').trim();
  await apiFetch(`/pallets/${id}`, { method: 'PATCH', body: JSON.stringify({ buyer }) });
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
  grade: string,
  tier: string,
): Promise<{ error?: string }> {
  const v = variant.trim();
  if (!v) return { error: 'Variant is required.' };
  try {
    await apiFetch(`/pallets/${palletId}/lines`, {
      method: 'POST',
      body: JSON.stringify({
        variant: v,
        tier: tier || undefined,
        quantity: Math.max(0, Math.trunc(quantity) || 0),
        grade: grade || undefined,
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
  grade: string,
  tier: string,
): Promise<void> {
  await apiFetch(`/pallets/${palletId}/lines/${lineId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      variant: variant.trim(),
      tier: tier || null,
      quantity: Math.max(0, Math.trunc(quantity) || 0),
      grade: grade || null,
      unitCost: unitCost ?? undefined,
    }),
  });
  revalidatePath(`/pallets/${palletId}`);
  revalidatePath('/pallets');
}

export async function deletePalletLine(palletId: string, lineId: string): Promise<void> {
  try {
    await apiFetch(`/pallets/${palletId}/lines/${lineId}`, { method: 'DELETE' });
  } catch (err) {
    // Already gone? That's the desired end state. Anything else (e.g. an expired
    // session -> 401) propagates so the caller can show it instead of failing silently.
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  revalidatePath(`/pallets/${palletId}`);
  revalidatePath('/pallets');
}

function str(value: FormDataEntryValue | null): string | undefined {
  const s = String(value ?? '').trim();
  return s === '' ? undefined : s;
}
