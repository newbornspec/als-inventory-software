'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';

export type RepairStatus = 'pending' | 'in_progress' | 'completed' | 'cannot_repair';

export interface RepairLog {
  id: string;
  assetId: string;
  description: string;
  partsUsed: string | null;
  cost: number | null;
  status: RepairStatus;
  performedById: string | null;
  performedBy?: { id: string; name: string } | null;
  completedAt: string | null;
  createdAt: string;
}

export async function createRepair(
  assetId: string,
  description: string,
  partsUsed: string,
  cost: number | null,
  status: RepairStatus,
): Promise<{ error?: string }> {
  if (!description.trim()) return { error: 'Describe the repair.' };
  try {
    await apiFetch(`/assets/${assetId}/repairs`, {
      method: 'POST',
      body: JSON.stringify({
        description: description.trim(),
        partsUsed: partsUsed.trim() || undefined,
        cost: cost ?? undefined,
        status,
      }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to add repair.' };
  }
  revalidatePath(`/assets/${assetId}`);
  return {};
}

export async function updateRepair(
  assetId: string,
  id: string,
  description: string,
  partsUsed: string,
  cost: number | null,
  status: RepairStatus,
): Promise<void> {
  await apiFetch(`/assets/${assetId}/repairs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      description: description.trim(),
      partsUsed: partsUsed.trim(),
      cost: cost ?? undefined,
      status,
    }),
  });
  revalidatePath(`/assets/${assetId}`);
}

export async function deleteRepair(assetId: string, id: string): Promise<void> {
  try {
    await apiFetch(`/assets/${assetId}/repairs/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  revalidatePath(`/assets/${assetId}`);
}
