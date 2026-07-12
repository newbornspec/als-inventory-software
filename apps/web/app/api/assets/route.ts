import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

// Client-callable proxy so the Lots accordion can lazy-load a lot's assets on
// expand (the API needs the httpOnly auth cookie, which client fetch can't read).
export async function GET(req: NextRequest) {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const qs = req.nextUrl.searchParams.toString();
  const res = await fetch(`${process.env.API_URL}/assets${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
