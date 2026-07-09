import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// The main access token lives in an httpOnly cookie (see app/api/auth/login),
// which client-side JS can never read — that's the point, it blocks XSS
// token theft. But the PowerSync client SDK authenticates its own sync
// connection directly and needs the raw JWT. This route is the one
// deliberate, narrow exception: it hands the token to same-origin JS on
// request, rather than making the token globally readable via document.cookie.
export async function GET() {
  const store = await cookies();
  const token = store.get('token')?.value;

  if (!token) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  return NextResponse.json({ token });
}
