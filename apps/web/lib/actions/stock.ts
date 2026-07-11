'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { ActionState } from './assets';

export type StockMovementReason = 'received' | 'sold' | 'adjusted' | 'returned' | 'scrapped';

export interface StockMovement {
  id: string;
  stockLineId: string;
  delta: number;
  reason: StockMovementReason;
  note: string | null;
  userId: string | null;
  createdAt: string;
}

export interface StockLine {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  productId: string | null;
  locationId: string | null;
  quantity: number;
  notes: string | null;
  location?: { id: string; name: string } | null;
  movements?: StockMovement[];
  createdAt: string;
  updatedAt: string;
}

export async function createStockLine(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const dto = {
    name: str(formData.get('name')),
    sku: str(formData.get('sku')),
    category: str(formData.get('category')),
    locationId: str(formData.get('locationId')),
    quantity: int(formData.get('quantity')),
    notes: str(formData.get('notes')),
  };
  if (!dto.name) return { error: 'Name is required.' };
  let created: StockLine;
  try {
    created = await apiFetch<StockLine>('/stock', { method: 'POST', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create stock item.' };
  }
  revalidatePath('/stock');
  redirect(`/stock/${created.id}`);
}

export async function adjustStock(
  lineId: string,
  delta: number,
  reason: StockMovementReason,
  note: string,
): Promise<{ error?: string }> {
  if (!delta) return { error: 'Enter an amount.' };
  try {
    await apiFetch(`/stock/${lineId}/adjust`, {
      method: 'POST',
      body: JSON.stringify({ delta, reason, note: note.trim() || undefined }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Adjustment failed.' };
  }
  revalidatePath(`/stock/${lineId}`);
  revalidatePath('/stock');
  return {};
}

export async function deleteStockLine(id: string): Promise<void> {
  await apiFetch(`/stock/${id}`, { method: 'DELETE' });
  revalidatePath('/stock');
  redirect('/stock');
}

function str(value: FormDataEntryValue | null): string | undefined {
  const s = String(value ?? '').trim();
  return s === '' ? undefined : s;
}
function int(value: FormDataEntryValue | null): number | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}
