import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Streams the API's data-erasure certificate (PDF) to the browser as a download,
// attaching the httpOnly auth cookie the client fetch can't read.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const res = await fetch(`${process.env.API_URL}/assets/${id}/erasure-certificate.pdf`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  // The link is a plain <a>, so whatever comes back here is the page the
  // operator sees. A refusal - no wipe on record, or a wipe that was only a
  // block discard (TRIM) - has to read as a sentence, not as raw JSON. Same
  // handling as the lot route.
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
