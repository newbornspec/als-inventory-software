'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'technician';
}

export interface ActionState {
  error: string | null;
}

export async function createUser(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const dto = {
    name: String(formData.get('name') ?? '').trim(),
    email: String(formData.get('email') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
    role: String(formData.get('role') ?? 'technician'),
  };

  if (!dto.name || !dto.email || dto.password.length < 8) {
    return { error: 'Name, email, and a password of at least 8 characters are required.' };
  }

  try {
    await apiFetch('/users', { method: 'POST', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to create user.' };
  }

  revalidatePath('/users');
  redirect('/users');
}

export async function updateUserRole(id: string, formData: FormData): Promise<void> {
  const role = String(formData.get('role') ?? '');
  await apiFetch(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) });
  revalidatePath('/users');
}

export async function deleteUser(id: string): Promise<void> {
  try {
    await apiFetch(`/users/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  revalidatePath('/users');
}
