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

  // DELETE (and other void) endpoints return 200/204 with an EMPTY body. Calling
  // res.json() on nothing throws "Unexpected end of JSON input", which used to
  // surface as a bogus "session expired" / server-side-exception on every delete.
  // Read as text and only parse when there's actually something to parse.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// DB-fresh identity INCLUDING permissions, via POST /auth/me — what the nav,
// the landing decision and permission-gated pages read. One API round trip
// per call; null when there is no session or the API is unreachable. Still
// UI-gating only: PermissionsGuard enforces access on every API call anyway.
export async function getSessionAccess(): Promise<
  (SessionUser & { name: string; permissions: string[] }) | null
> {
  try {
    return await apiFetch('/auth/me', { method: 'POST' });
  } catch {
    return null;
  }
}

// Decodes (does NOT verify) the JWT payload for UI-gating purposes only —
// e.g. hiding an "Edit" button for technicians. This is never a security
// boundary: the API's PermissionsGuard is what actually enforces access on
// every endpoint, regardless of what this function returns. Note the payload
// carries NO permissions and its role can be up to 12h stale — use
// getSessionAccess() where either matters.
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
