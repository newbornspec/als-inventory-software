import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { downloadError } from '@/lib/download-error';

// Streams the API's formatted .xlsx lot report to the browser as a download,
// attaching the httpOnly auth cookie the client fetch can't read.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return downloadError(401, 'lot report');
  }

  const res = await fetch(`${process.env.API_URL}/batches/${id}/report.xlsx`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!res.ok) {
    return downloadError(res.status, 'lot report');
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':
        res.headers.get('content-disposition') ?? `attachment; filename="lot-${id}.xlsx"`,
    },
  });
}
