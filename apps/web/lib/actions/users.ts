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
  // NULL/absent = enabled. A timestamp rather than a flag so the list can say
  // WHEN someone was switched off, which matters when the question is whether
  // an audit was filed before or after they left.
  disabledAt?: string | null;
  // A SHARED account (the audit station's login) rather than one person.
  // Absent from an older API: treated as false.
  isStation?: boolean;
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
    // An unticked checkbox sends nothing, so absence means "not a station".
    // The checkbox is always rendered on this form, so this never clears the
    // flag by accident.
    isStation: formData.get('isStation') === 'on',
  };
  try {
    await apiFetch(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(dto) });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Failed to update access.' };
  }
  revalidatePath('/users');
  redirect('/users');
}

// Switch an account off (or back on) without deleting it. Preferred over
// deleteUser for anyone who has done work: every foreign key to users is
// ON DELETE SET NULL, so deleting strips their name off every audit, wipe,
// sale and photo. Disabling stops the access and keeps the record.
export async function setUserDisabled(id: string, disabled: boolean): Promise<void> {
  await apiFetch(`/users/${id}/disabled`, {
    method: 'PATCH',
    body: JSON.stringify({ disabled }),
  });
  revalidatePath('/users');
}

// Set someone's password for them. Also the only way to change your OWN, which
// is why the API allows it on your own account: unlike disabling yourself it
// locks nobody out, it just ends your current session.
//
// Deliberately no revalidatePath: nothing about the page's rendered content
// changes, and after resetting your own password this request's cookie is
// already stale, so revalidating would render the page as signed-out.
export async function resetUserPassword(id: string, password: string): Promise<void> {
  await apiFetch(`/users/${id}/password`, {
    method: 'PATCH',
    body: JSON.stringify({ password }),
  });
}

export async function deleteUser(id: string): Promise<void> {
  try {
    await apiFetch(`/users/${id}`, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  revalidatePath('/users');
}
