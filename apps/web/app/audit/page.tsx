import { redirect } from 'next/navigation';
import { apiFetch, getSessionAccess } from '@/lib/api-server';
import { hasPermission, landingFor } from '@/lib/permissions';
import { Nav } from '@/app/components/nav';
import { Breadcrumbs } from '@/app/components/breadcrumbs';
import { AuditDays, type AuditDaySummary } from './audit-days';

// The Audit workspace: a chronological, day-grouped feed of audit activity
// across every device — deliberately NOT the Goods In batch-card shape.
// Audits belong to the device (one asset_audits row per EVENT, re-audited
// over its life), so the drill-down here is day -> device -> events, and a
// device is reached through itself, never through the lot it arrived in.
export default async function AuditPage() {
  const access = await getSessionAccess();
  if (!access || !hasPermission(access, 'amazon_audit')) redirect(landingFor(access));

  const days = await apiFetch<AuditDaySummary[]>('/audits/days?limit=60').catch(
    () => [] as AuditDaySummary[],
  );

  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-white text-neutral-950 px-4 py-6 sm:p-8">
        <Breadcrumbs items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Audit' }]} />
        <h1 className="mt-3 text-2xl font-semibold">Audit</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-500">
          Audit activity by day, newest first. A device is counted once per day however many
          events its session produced — expand it to see the full trail.
        </p>

        {days.length === 0 ? (
          <p className="mt-6 text-sm text-neutral-500">No audits recorded yet.</p>
        ) : (
          <AuditDays days={days} />
        )}
      </main>
    </>
  );
}
