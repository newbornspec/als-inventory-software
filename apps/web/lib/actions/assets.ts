'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';

export interface Asset {
  id: string;
  tag: string;
  name: string;
  category: string;
  stockStatus: string;
  conditionGrade: string | null;
  auditStatus: string | null;
  locationId: string | null;
  ownerId: string | null;
  imageUrl: string | null;
  warrantyExpiresAt: string | null;
  batchId: string | null;
  lotId: string | null;
  updatedAt: string;
  location?: { id: string; name: string } | null;
}

export interface ActionState {
  error: string | null;
}

export async function createAsset(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const dto = {
    tag: String(formData.get('tag') ?? '').trim(),
    name: String(formData.get('name') ?? '').trim(),
    category: String(formData.get('category') ?? '').trim(),
    stockStatus: String(formData.get('stockStatus') ?? 'received'),
    conditionGrade: emptyToUndefined(formData.get('conditionGrade')),
    locationId: emptyToUndefined(formData.get('locationId')),
    warrantyExpiresAt: emptyToUndefined(formData.get('warrantyExpiresAt')),
  };

  if (!dto.tag || !dto.name || !dto.category) {
    return { error: 'Tag, name, and category are required.' };
  }

  let created: Asset;
  try {
    created = await apiFetch<Asset>('/assets', { method: 'POST', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create asset.' };
  }

  revalidatePath('/assets');
  redirect(`/assets/${created.id}`);
}

export async function updateAsset(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const dto = {
    name: String(formData.get('name') ?? '').trim(),
    category: String(formData.get('category') ?? '').trim(),
    stockStatus: String(formData.get('stockStatus') ?? ''),
    conditionGrade: emptyToUndefined(formData.get('conditionGrade')),
    locationId: emptyToUndefined(formData.get('locationId')),
    warrantyExpiresAt: emptyToUndefined(formData.get('warrantyExpiresAt')),
  };

  try {
    await apiFetch(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to update asset.' };
  }

  revalidatePath('/assets');
  revalidatePath(`/assets/${id}`);
  return { error: null };
}

export async function deleteAsset(id: string): Promise<void> {
  await apiFetch(`/assets/${id}`, { method: 'DELETE' });
  revalidatePath('/assets');
  redirect('/assets');
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  const str = String(value ?? '').trim();
  return str === '' ? undefined : str;
}
