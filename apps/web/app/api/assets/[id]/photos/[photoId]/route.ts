import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Streams a stored device photo so a plain <img src> works without exposing the
// JWT (same pattern as the barcode route).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  const { id, photoId } = await params;
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });

  const res = await fetch(`${process.env.API_URL}/assets/${id}/photos/${photoId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return NextResponse.json({ message: 'Not found' }, { status: res.status });

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': res.headers.get('content-type') ?? 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
