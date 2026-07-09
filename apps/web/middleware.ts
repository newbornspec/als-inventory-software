import { NextRequest, NextResponse } from 'next/server';

const PROTECTED_PREFIXES = ['/dashboard', '/scan', '/assets', '/batches', '/reports', '/users'];

export function middleware(request: NextRequest) {
  const isProtected = PROTECTED_PREFIXES.some((p) =>
    request.nextUrl.pathname.startsWith(p),
  );
  if (!isProtected) return NextResponse.next();

  const token = request.cookies.get('token');
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
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
  ],
};
