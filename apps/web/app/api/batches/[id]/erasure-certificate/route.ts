import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Streams the API's bulk (lot) data-erasure certificate (PDF) to the browser,
// attaching the httpOnly auth cookie. On a 4xx (e.g. no wiped devices in the
// lot) it surfaces the API's message as plain text rather than a broken file.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const res = await fetch(`${process.env.API_URL}/batches/${id}/erasure-certificate.pdf`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = await res.text();
    let message = body;
    try {
      message = JSON.parse(body).message ?? body;
    } catch {
      /* not JSON */
    }
    return new NextResponse(message || 'Failed to generate certificate', {
      status: res.status,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        res.headers.get('content-disposition') ?? `attachment; filename="erasure-certificate-${id}.pdf"`,
    },
  });
}
