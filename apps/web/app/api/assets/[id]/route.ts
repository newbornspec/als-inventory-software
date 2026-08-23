import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

// Client-callable proxy for one asset's full record — the Goods In workspace
// loads the selected unit's captured hardware profile on click (the profile is
// select:false on list queries, so only this detail fetch carries it). Same
// cookie-forwarding shape as the /api/assets list proxy above it.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const { id } = await params;
  const res = await fetch(`${process.env.API_URL}/assets/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
