import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

// Client-callable proxy so the Audit workspace can lazy-load a day's devices
// on expand (the API needs the httpOnly auth cookie, which client fetch can't
// read). Same pattern as /api/assets.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ day: string }> },
) {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const { day } = await params;
  // The API validates the format; this just refuses to build a silly URL.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ message: 'Invalid day' }, { status: 400 });
  }

  const res = await fetch(`${process.env.API_URL}/audits/days/${day}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
