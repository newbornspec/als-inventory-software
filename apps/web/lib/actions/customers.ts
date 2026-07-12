'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';
import type { ActionState } from './assets';

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function createCustomer(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const dto = {
    name: str(formData.get('name')),
    email: str(formData.get('email')),
    phone: str(formData.get('phone')),
    notes: str(formData.get('notes')),
  };
  if (!dto.name) return { error: 'Name is required.' };
  try {
    await apiFetch('/customers', { method: 'POST', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create customer.' };
  }
  revalidatePath('/customers');
  redirect('/customers');
}

export async function deleteCustomer(id: string): Promise<void> {
  await apiFetch(`/customers/${id}`, { method: 'DELETE' });
  revalidatePath('/customers');
}

function str(value: FormDataEntryValue | null): string | undefined {
  const s = String(value ?? '').trim();
  return s === '' ? undefined : s;
}
