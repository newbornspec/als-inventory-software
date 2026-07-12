import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

// Forwards a base64 photo upload to the API with the httpOnly auth cookie the
// client fetch can't read. (Uses a route handler rather than a server action so
// the payload isn't bound by the server-action body-size limit.)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });

  const body = await request.text();
  const res = await fetch(`${process.env.API_URL}/assets/${id}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
    cache: 'no-store',
  });

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
