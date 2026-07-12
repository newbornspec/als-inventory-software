import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Streams the API's formatted .xlsx lot report to the browser as a download,
// attaching the httpOnly auth cookie the client fetch can't read.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const res = await fetch(`${process.env.API_URL}/batches/${id}/report.xlsx`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!res.ok) {
    return NextResponse.json({ message: 'Failed to generate report' }, { status: res.status });
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
