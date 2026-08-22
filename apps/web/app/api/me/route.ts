import { NextResponse } from 'next/server';
import { getSessionAccess } from '@/lib/api-server';

// Used by client components (Nav, the login destination decision) that need
// the current user's role AND permissions without ever handing the JWT itself
// to client-side JS. DB-fresh via the API's /auth/me, so an admin's grant
// edit reaches the nav on the next page load — the token payload couldn't
// carry permissions and its role can be up to 12h stale.
export async function GET() {
  const user = await getSessionAccess();
  if (!user) return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  return NextResponse.json(user);
}
