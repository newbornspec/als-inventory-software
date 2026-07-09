import 'server-only';
import { cookies } from 'next/headers';

export interface SessionUser {
  userId: string;
  email: string;
  role: 'admin' | 'manager' | 'technician';
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Server-only fetch helper: reads the httpOnly JWT cookie and calls the
// NestJS API directly. Only usable from Server Components, Server Actions,
// and Route Handlers — never import this from a 'use client' file (the
// 'server-only' import above will fail the build if you try).
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const store = await cookies();
  const token = store.get('token')?.value;

  const res = await fetch(`${process.env.API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.message ?? `Request failed: ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// Decodes (does NOT verify) the JWT payload for UI-gating purposes only —
// e.g. hiding an "Edit" button for technicians. This is never a security
// boundary: NestJS's RolesGuard is what actually enforces access on every
// write endpoint, regardless of what this function returns.
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) return null;

  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
    return { userId: payload.sub, email: payload.email, role: payload.role };
  } catch {
    return null;
  }
}
