import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET() {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const res = await fetch(`${process.env.API_URL}/reports/profit.csv`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!res.ok) {
    return NextResponse.json({ message: 'Failed to export report' }, { status: res.status });
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="lot-profit.csv"',
    },
  });
}
