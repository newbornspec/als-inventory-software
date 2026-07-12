'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { ActionState } from './assets';

export type SalesOrderStatus =
  | 'draft'
  | 'reserved'
  | 'picking'
  | 'picked'
  | 'invoiced'
  | 'shipped'
  | 'completed'
  | 'cancelled';

export interface OrderLine {
  id: string;
  orderId: string;
  description: string | null;
  assetId: string | null;
  asset?: { id: string; tag: string; name: string } | null;
  quantity: number;
  unitPrice: number | null;
  createdAt: string;
}

export interface SalesOrder {
  id: string;
  orderNumber: string;
  customerId: string | null;
  status: SalesOrderStatus;
  orderRef: string | null;
  notes: string | null;
  total: number;
  lineCount: number;
  customer?: { id: string; name: string } | null;
  lines?: OrderLine[];
}

export async function createOrder(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const dto = {
    customerId: str(formData.get('customerId')),
    orderRef: str(formData.get('orderRef')),
    notes: str(formData.get('notes')),
  };
  let created: SalesOrder;
  try {
    created = await apiFetch<SalesOrder>('/orders', { method: 'POST', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create order.' };
  }
  revalidatePath('/orders');
  redirect(`/orders/${created.id}`);
}

export async function updateOrderStatus(id: string, formData: FormData): Promise<void> {
  const status = String(formData.get('status') ?? '');
  await apiFetch(`/orders/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  revalidatePath(`/orders/${id}`);
  revalidatePath('/orders');
}

export async function deleteOrder(id: string): Promise<void> {
  await apiFetch(`/orders/${id}`, { method: 'DELETE' });
  revalidatePath('/orders');
  redirect('/orders');
}

export async function addOrderLine(
  orderId: string,
  description: string,
  quantity: number,
  unitPrice: number | null,
): Promise<{ error?: string }> {
  if (!description.trim()) return { error: 'Enter a description.' };
  try {
    await apiFetch(`/orders/${orderId}/lines`, {
      method: 'POST',
      body: JSON.stringify({
        description: description.trim(),
        quantity: Math.max(1, Math.trunc(quantity) || 1),
        unitPrice: unitPrice ?? undefined,
      }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to add line.' };
  }
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  return {};
}

export async function addOrderLineByTag(
  orderId: string,
  tag: string,
  unitPrice: number | null,
): Promise<{ error?: string }> {
  if (!tag.trim()) return { error: 'Enter a serial / asset tag.' };
  try {
    await apiFetch(`/orders/${orderId}/lines`, {
      method: 'POST',
      body: JSON.stringify({ assetTag: tag.trim(), unitPrice: unitPrice ?? undefined }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to add device.' };
  }
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  return {};
}

export async function updateOrderLine(
  orderId: string,
  lineId: string,
  quantity: number,
  unitPrice: number | null,
): Promise<void> {
  await apiFetch(`/orders/${orderId}/lines/${lineId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      quantity: Math.max(1, Math.trunc(quantity) || 1),
      unitPrice: unitPrice ?? undefined,
    }),
  });
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
}

export async function deleteOrderLine(orderId: string, lineId: string): Promise<void> {
  await apiFetch(`/orders/${orderId}/lines/${lineId}`, { method: 'DELETE' });
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
}

function str(value: FormDataEntryValue | null): string | undefined {
  const s = String(value ?? '').trim();
  return s === '' ? undefined : s;
}
