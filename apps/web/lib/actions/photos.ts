'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';

export interface PhotoMeta {
  id: string;
  assetId: string;
  contentType: string;
  caption: string | null;
  uploadedBy: { id: string; name: string } | null;
  createdAt: string;
}

export async function deletePhoto(assetId: string, id: string): Promise<void> {
  try {
    await apiFetch(`/assets/${assetId}/photos/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  revalidatePath(`/assets/${assetId}`);
}
