import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/api-server';

// Used by client components (Nav) that need to know the current user's role
// for conditional UI (e.g. hiding "Users"/"Reports" links from technicians)
// without ever handing the JWT itself to client-side JS.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  return NextResponse.json(user);
}
