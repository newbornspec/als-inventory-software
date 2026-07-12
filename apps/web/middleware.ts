import { NextRequest, NextResponse } from 'next/server';

// Every authenticated area of the app. Anything not listed is public.
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/scan',
  '/assets',
  '/batches',
  '/reports',
  '/users',
  '/pallets',
  '/stock',
  '/orders',
  '/customers',
];

const ACCESS_MAX_AGE = 60 * 60 * 12; // 12h
const REFRESH_MAX_AGE = 60 * 60 * 24 * 7; // 7d

// Reads a JWT's exp WITHOUT verifying the signature — this is only a UX gate;
// NestJS still enforces auth on every API call. Edge runtime has no Buffer, so
// decode base64url with atob (and pad it, since atob wants standard base64).
function isJwtExpired(token: string): boolean {
  try {
    let b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const payload = JSON.parse(atob(b));
    return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
  } catch {
    return true; // unparseable/garbage token — treat as invalid
  }
}

export async function middleware(request: NextRequest) {
  const isProtected = PROTECTED_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p));
  if (!isProtected) return NextResponse.next();

  const token = request.cookies.get('token')?.value;
  if (token && !isJwtExpired(token)) return NextResponse.next();

  // Access token missing/expired — silently renew it from the refresh token so
  // the session survives (up to the 7-day refresh window) with no re-login and
  // no silent write failures. Bounded risk: if refresh fails we fall through to
  // the same login redirect as before.
  const refreshToken = request.cookies.get('refreshToken')?.value;
  if (refreshToken && !isJwtExpired(refreshToken)) {
    try {
      const res = await fetch(`${process.env.API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        const secure = process.env.NODE_ENV === 'production';

        // Forward the fresh access token to THIS request (so the page/action
        // about to run authenticates) and persist both cookies for later.
        const pairs = request.cookies
          .getAll()
          .map((c) => (c.name === 'token' ? `token=${data.accessToken}` : `${c.name}=${c.value}`));
        if (!request.cookies.has('token')) pairs.push(`token=${data.accessToken}`);
        const headers = new Headers(request.headers);
        headers.set('cookie', pairs.join('; '));

        const response = NextResponse.next({ request: { headers } });
        response.cookies.set('token', data.accessToken, {
          httpOnly: true,
          secure,
          sameSite: 'strict',
          maxAge: ACCESS_MAX_AGE,
          path: '/',
        });
        response.cookies.set('refreshToken', data.refreshToken, {
          httpOnly: true,
          secure,
          sameSite: 'strict',
          maxAge: REFRESH_MAX_AGE,
          path: '/',
        });
        return response;
      }
    } catch {
      // network/refresh failure — fall through to login
    }
  }

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('from', request.nextUrl.pathname);
  const response = NextResponse.redirect(loginUrl);
  response.cookies.delete('token');
  response.cookies.delete('refreshToken');
  return response;
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/scan/:path*',
    '/assets/:path*',
    '/batches/:path*',
    '/reports/:path*',
    '/users/:path*',
    '/pallets/:path*',
    '/stock/:path*',
    '/orders/:path*',
    '/customers/:path*',
  ],
};
