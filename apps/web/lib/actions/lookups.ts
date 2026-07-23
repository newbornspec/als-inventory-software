'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';

export interface LookupValue {
  id: string;
  category: string;
  value: string;
  parentId: string | null;
  active: boolean;
  sortOrder: number;
}

export const LOOKUP_CATEGORIES = [
  'manufacturer',
  'model',
  'chassis',
  'cpu',
  'ram',
  'storage',
] as const;

export async function addLookup(
  category: string,
  value: string,
  parentId?: string | null,
): Promise<{ error?: string }> {
  const v = value.trim();
  if (!v) return { error: 'Enter a value.' };
  try {
    await apiFetch('/lookups', {
      method: 'POST',
      body: JSON.stringify({ category, value: v, parentId: parentId || undefined }),
    });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Could not add value.' };
  }
  revalidatePath('/lookups');
  return {};
}

export async function updateLookup(
  id: string,
  patch: { value?: string; active?: boolean; sortOrder?: number },
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/lookups/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Could not update value.' };
  }
  revalidatePath('/lookups');
  return {};
}

export async function deleteLookup(id: string): Promise<{ error?: string }> {
  try {
    await apiFetch(`/lookups/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) {
      return { error: err instanceof ApiError ? err.message : 'Could not delete value.' };
    }
  }
  revalidatePath('/lookups');
  return {};
}
