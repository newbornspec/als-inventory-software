import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { downloadError } from '@/lib/download-error';

// Streams the API's pallet costing sheet (PDF) to the browser as a download,
// attaching the httpOnly auth cookie the client fetch can't read. Same shape as
// the report route beside it.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return downloadError(401, 'pallet costing sheet');
  }

  const res = await fetch(`${process.env.API_URL}/pallets/${id}/costing.pdf`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!res.ok) {
    return downloadError(res.status, 'pallet costing sheet');
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        res.headers.get('content-disposition') ?? `attachment; filename="costing-${id}.pdf"`,
    },
  });
}
