'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-server';

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'technician';
  permissions: string[];
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
    // Repeated checkbox fields from the ACCESS/ACTIONS grid. Always present —
    // the picker renders on the form — so an all-unticked grid deliberately
    // means "no permissions", not "use the role default".
    permissions: formData.getAll('permissions').map(String),
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

// The inline role dropdown on the Users list. Sends ONLY the role, which the
// API documents as "reset permissions to the new role's baseline" — the list
// page says so next to the control.
export async function updateUserRole(id: string, formData: FormData): Promise<void> {
  const role = String(formData.get('role') ?? '');
  await apiFetch(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) });
  revalidatePath('/users');
}

// The Access page: role and the full permissions grid together, so a role
// change made here keeps the grants exactly as ticked.
export async function updateUserAccess(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const dto = {
    role: String(formData.get('role') ?? ''),
    permissions: formData.getAll('permissions').map(String),
  };
  try {
    await apiFetch(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to update access.' };
  }
  revalidatePath('/users');
  redirect('/users');
}

export async function deleteUser(id: string): Promise<void> {
  try {
    await apiFetch(`/users/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  revalidatePath('/users');
}
