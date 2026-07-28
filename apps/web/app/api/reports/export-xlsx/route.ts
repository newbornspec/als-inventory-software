import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { downloadError } from '@/lib/download-error';

// Streams the API's multi-sheet reports workbook, forwarding the current date
// range + filters (from the query string) and the httpOnly auth cookie.
export async function GET(req: Request) {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) return downloadError(401, 'Excel report');

  const qs = new URL(req.url).searchParams.toString();
  const res = await fetch(`${process.env.API_URL}/reports/export.xlsx?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return downloadError(res.status, 'Excel report');

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':
        res.headers.get('content-disposition') ?? 'attachment; filename="als-reports.xlsx"',
    },
  });
}
