import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { downloadError } from '@/lib/download-error';

export async function GET() {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return downloadError(401, 'profit CSV');
  }

  const res = await fetch(`${process.env.API_URL}/reports/profit.csv`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!res.ok) {
    return downloadError(res.status, 'profit CSV');
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="lot-profit.csv"',
    },
  });
}
