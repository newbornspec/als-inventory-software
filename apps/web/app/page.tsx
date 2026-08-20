import { redirect } from 'next/navigation';

// '/' lands on the control centre, not the login screen. Middleware already
// bounces anyone without a valid session from /dashboard to /login (with a
// ?from= so they come back here), so a signed-in user typing the bare domain no
// longer has to log in again to reach the app.
export default function Home() {
  redirect('/dashboard');
}
