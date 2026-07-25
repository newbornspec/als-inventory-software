import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Streams the API's multi-sheet reports workbook, forwarding the current date
// range + filters (from the query string) and the httpOnly auth cookie.
export async function GET(req: Request) {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });

  const qs = new URL(req.url).searchParams.toString();
  const res = await fetch(`${process.env.API_URL}/reports/export.xlsx?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return NextResponse.json({ message: 'Failed to export report' }, { status: res.status });

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':
        res.headers.get('content-disposition') ?? 'attachment; filename="als-reports.xlsx"',
    },
  });
}
