import { SignOutButton } from './sign-out-button';

// Where landingFor() sends a signed-in user whose account holds no module
// permissions at all. A real page instead of a redirect loop: every other
// destination assumes at least one module, and bouncing a zero-module user
// between /login and /dashboard helps nobody.
export default function NoAccessPage() {
  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 text-center">
        <h1 className="text-xl font-semibold text-neutral-950">No modules enabled</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Your account is active, but no areas of ALS Inventory have been enabled for it yet.
          Ask an administrator to open Users &rarr; Access and grant you what you need.
        </p>
        <div className="mt-6">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
