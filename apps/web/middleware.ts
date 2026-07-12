import { NextRequest, NextResponse } from 'next/server';

// Every authenticated area of the app. Anything not listed here (login, etc.)
// is public. Pallets/orders/customers/stock were previously missing, so a
// logged-out or expired session rendered them and crashed on the API's 401
// instead of being sent to login.
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

// Reads the JWT's exp claim WITHOUT verifying the signature — this is only a UX
// gate (send stale sessions to login); NestJS still enforces auth on every API
// call. Edge runtime has no Buffer, so decode base64url with atob.
function isTokenExpired(token: string): boolean {
  try {
    const part = token.split('.')[1];
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64));
    return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
  } catch {
    return true; // unparseable/garbage token — treat as invalid
  }
}

export function middleware(request: NextRequest) {
  const isProtected = PROTECTED_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p));
  if (!isProtected) return NextResponse.next();

  const token = request.cookies.get('token')?.value;
  if (!token || isTokenExpired(token)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', request.nextUrl.pathname);
    const res = NextResponse.redirect(loginUrl);
    res.cookies.delete('token'); // drop the stale cookie so we don't loop
    return res;
  }

  return NextResponse.next();
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
