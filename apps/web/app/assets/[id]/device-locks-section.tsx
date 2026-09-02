// Device Locks & Management Status, captured by tools/lock-checks.sh and stored
// in the hardware profile under `locks`.
//
// Rendered on its own rather than through HardwareSection's generic walker,
// because this is the one part of an audit someone makes a buying decision on:
// can this machine be refurbished and resold, or is it tied to somebody else's
// organisation? A generic key/value dump would bury that under nested arrays.

type LockStatus = 'PASS' | 'DETECTED' | 'LOCKED' | 'WARNING' | 'UNKNOWN';
type DeviceStatus = 'CLEAR' | 'LOCKED' | 'WARNING' | 'UNVERIFIED';

export interface DeviceLocks {
  status?: DeviceStatus;
  checks?: Array<{
    key?: string;
    label?: string;
    status?: LockStatus;
    detail?: string;
    method?: string;
    confidence?: 'high' | 'medium' | 'low';
  }>;
}

// Every style pairs colour with a word that carries the same meaning on its
// own. WCAG 1.4.1: status is never conveyed by colour alone, and a printed or
// greyscale copy of this page has to read identically.
const DEVICE_STYLE: Record<DeviceStatus, { box: string; note: string }> = {
  CLEAR:      { box: 'border-green-300 bg-green-50 text-green-900',    note: 'Every check ran and found no locks.' },
  WARNING:    { box: 'border-amber-300 bg-amber-50 text-amber-900',    note: 'Restrictions found that may affect refurbishment.' },
  LOCKED:     { box: 'border-red-300 bg-red-50 text-red-900',          note: 'An ownership or management lock was found — this machine cannot be freely resold.' },
  UNVERIFIED: { box: 'border-neutral-300 bg-neutral-50 text-neutral-900', note: 'Some checks could not be completed. Treat as unproven, not as clear.' },
};

const CHECK_STYLE: Record<LockStatus, string> = {
  PASS:     'border-green-300 text-green-900',
  DETECTED: 'border-amber-400 text-amber-900',
  WARNING:  'border-amber-400 text-amber-900',
  LOCKED:   'border-red-400 text-red-900',
  UNKNOWN:  'border-neutral-400 text-neutral-700',
};

export function DeviceLocksSection({ locks }: { locks: DeviceLocks | null | undefined }) {
  const checks = locks?.checks ?? [];
  if (!locks || checks.length === 0) return null;

  const status: DeviceStatus = locks.status ?? 'UNVERIFIED';
  const style = DEVICE_STYLE[status] ?? DEVICE_STYLE.UNVERIFIED;
  const unknowns = checks.filter((c) => c.status === 'UNKNOWN').length;

  return (
    <section className="md:col-span-2 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">
          Device locks &amp; management status
        </h2>
        <span className="text-xs text-neutral-500">Auto-captured · read-only</span>
      </div>

      {/* The verdict, stated as a word rather than a colour. */}
      <div className={`mt-3 rounded-lg border px-4 py-3 ${style.box}`}>
        <p className="text-sm font-semibold">DEVICE STATUS: {status}</p>
        <p className="mt-0.5 text-sm">{style.note}</p>
        {unknowns > 0 && status !== 'LOCKED' && (
          <p className="mt-1 text-sm">
            {unknowns} of {checks.length} checks could not be verified — see below for why.
          </p>
        )}
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">
            Ownership, management and firmware lock checks for this device, each with the
            method used to determine it and the confidence in that method.
          </caption>
          <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-600">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Check</th>
              <th scope="col" className="px-3 py-2 font-medium">Result</th>
              <th scope="col" className="px-3 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c, i) => (
              <tr key={c.key ?? i} className="border-t border-neutral-200 align-top">
                <th scope="row" className="px-3 py-2 font-medium text-neutral-950">
                  {c.label ?? c.key}
                </th>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold ${
                      CHECK_STYLE[c.status ?? 'UNKNOWN'] ?? CHECK_STYLE.UNKNOWN
                    }`}
                  >
                    {c.status ?? 'UNKNOWN'}
                  </span>
                </td>
                <td className="px-3 py-2 text-neutral-700">
                  {c.detail}
                  {/* How the answer was reached, so a surprising result can be
                      traced to the thing that produced it rather than taken on
                      faith. */}
                  {c.method && (
                    <span className="mt-0.5 block text-xs text-neutral-600">
                      via {c.method}
                      {c.confidence ? ` · confidence: ${c.confidence}` : ''}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-neutral-600">
        Locks are reported here, never removed. Clearing an Autopilot or MDM registration is the
        registering organisation&rsquo;s job through Microsoft&rsquo;s own deregistration process.
        A result of UNKNOWN means the check could not be completed — it does not mean the device
        is clear.
      </p>
    </section>
  );
}
