import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Client-callable proxy for the transfer confirmation dialog: it shows the
// operator which pallet number they are about to create. Display only — the
// authoritative number is generated at create time, so a concurrent create on
// another machine costs nothing worse than the dialog being off by one.
export async function GET() {
  const store = await cookies();
  const token = store.get('token')?.value;
  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const res = await fetch(`${process.env.API_URL}/pallets/next-number`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
