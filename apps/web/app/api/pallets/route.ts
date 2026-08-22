import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Client-callable proxy so the Move to Pallet picker can list destination
// pallets (the API needs the httpOnly auth cookie, which client fetch can't
// read). Same pattern as /api/assets.
export async function GET() {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const res = await fetch(`${process.env.API_URL}/pallets`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
