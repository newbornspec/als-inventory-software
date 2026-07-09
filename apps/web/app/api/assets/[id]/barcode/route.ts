import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

// Proxies the barcode/QR PNG through Next.js so the browser <img> tag never
// needs the JWT directly — <img src> can't send an Authorization header,
// and the token lives in an httpOnly cookie anyway. Same pattern as the
// PowerSync token route: server-side code reads the cookie, the client never sees it.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const type = request.nextUrl.searchParams.get('type') === 'code128' ? 'code128' : 'qr';

  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const res = await fetch(`${process.env.API_URL}/assets/${id}/barcode?type=${type}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!res.ok) {
    return NextResponse.json({ message: 'Failed to generate barcode' }, { status: res.status });
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
    },
  });
}
