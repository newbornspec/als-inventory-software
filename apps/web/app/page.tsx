import { redirect } from 'next/navigation';
import { getSessionAccess } from '@/lib/api-server';
import { landingFor } from '@/lib/permissions';

// '/' lands where this user's permissions say they belong — the dashboard for
// most people, a single-module user's own module otherwise. Anyone without a
// session falls through to /dashboard, where middleware bounces them to
// /login with ?from= so they come back to the right place after signing in.
export default async function Home() {
  const access = await getSessionAccess();
  redirect(access ? landingFor(access) : '/dashboard');
}
