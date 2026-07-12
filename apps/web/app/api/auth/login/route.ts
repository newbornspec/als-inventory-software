import { NextResponse } from 'next/server';

// Proxies to the NestJS API and stores the JWT as an httpOnly cookie, so the
// access token never touches client-side JS (no XSS-exfiltration surface).
export async function POST(request: Request) {
  const body = await request.json();

  const res = await fetch(`${process.env.API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return NextResponse.json({ message: 'Invalid credentials' }, { status: 401 });
  }

  const data = await res.json();
  const response = NextResponse.json({ user: data.user });

  response.cookies.set('token', data.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 12, // matches JWT_EXPIRES_IN default of 12h
    path: '/',
  });
  response.cookies.set('refreshToken', data.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7, // matches JWT_REFRESH_EXPIRES_IN default of 7d
    path: '/',
  });

  return response;
}
