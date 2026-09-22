'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  recordAutopilotOobe,
  type OobeResult,
} from '@/lib/actions/autopilot-oobe';

// What a technician saw on the machine's first Windows screen after imaging.
//
// This is the only Autopilot answer in the system that is not inference.
// Everything the audit station reports is read from OUTSIDE a running Windows,
// and on a wiped disk there is nothing to read at all - registration lives in
// Microsoft's cloud against the hardware hash, and no third party can query
// it. At first boot the machine asks for itself, and a registered device is
// shown the owning organisation's branded sign-in.
//
// So the form asks one question, in the words the technician is looking at.

export interface OobeCheck {
  result?: OobeResult;
  organisation?: string | null;
  reason?: string | null;
  photographed?: boolean;
  note?: string | null;
  checkedAt?: string;
  checkedByName?: string | null;
}

const SEEN: Record<OobeResult, { label: string; hint: string }> = {
  organisation: {
    label: 'It named an organisation',
    hint: 'The sign-in screen showed a company name or logo. The device is registered to them.',
  },
  generic: {
    label: "Microsoft's generic setup",
    hint: '"Is this the right country/region?" with no company branding anywhere.',
  },
  blocked: {
    label: 'Could not check',
    hint: 'No network at setup, the machine would not boot, or it was not imaged.',
  },
};

function Recorded({ check }: { check: OobeCheck }) {
  const when = check.checkedAt
    ? new Date(check.checkedAt).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;
  const tone =
    check.result === 'organisation'
      ? 'border-red-300 bg-red-50 text-red-900'
      : check.result === 'generic'
        ? 'border-green-300 bg-green-50 text-green-900'
        : 'border-neutral-300 bg-neutral-50 text-neutral-800';
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${tone}`}>
      <p className="font-medium">
        {check.result === 'organisation'
          ? `First-boot setup named an organisation${check.organisation ? `: ${check.organisation}` : ''}`
          : check.result === 'generic'
            ? 'First-boot setup was the generic Microsoft one'
            : 'The first-boot check could not be made'}
      </p>
      <p className="mt-1">
        {check.result === 'organisation' ? (
          <>
            This device is Autopilot-registered and cannot be resold until that
            organisation — or Microsoft support, on proof of ownership —
            deregisters it.
          </>
        ) : check.result === 'generic' ? (
          <>
            Microsoft served no Autopilot profile to this device on that date.
            That is the strongest negative obtainable, and not a guarantee for
            all time: a registration added later would not have shown.
          </>
        ) : (
          <>
            {check.reason ? `${check.reason}. ` : ''}Nothing is concluded from
            this either way.
          </>
        )}
      </p>
      {check.result === 'organisation' && !check.photographed && (
        <p className="mt-1 font-medium">
          No photograph was kept. Microsoft&apos;s deregistration process asks
          for a screenshot of that screen by name.
        </p>
      )}
      {check.note && <p className="mt-1 italic">{check.note}</p>}
      {(when || check.checkedByName) && (
        <p className="mt-1 text-xs opacity-80">
          Recorded{check.checkedByName ? ` by ${check.checkedByName}` : ''}
          {when ? ` · ${when}` : ''}
        </p>
      )}
    </div>
  );
}

export function AutopilotOobeCheck({
  assetId,
  check,
  canRecord,
}: {
  assetId: string;
  check?: OobeCheck | null;
  canRecord: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<OobeResult | ''>('');
  const [organisation, setOrganisation] = useState('');
  const [reason, setReason] = useState('');
  const [photographed, setPhotographed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorded = check?.result ? check : null;

  async function submit() {
    if (!result) return;
    setBusy(true);
    setError(null);
    const res = await recordAutopilotOobe(assetId, {
      result,
      organisation: organisation.trim() || undefined,
      reason: reason.trim() || undefined,
      photographed,
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="mt-4 rounded-md border border-neutral-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-neutral-900">
          First-boot setup screen
        </h4>
        <span className="text-xs text-neutral-600">
          Recorded by hand — the only check Microsoft answers directly
        </span>
      </div>

      {recorded ? (
        <div className="mt-2">
          <Recorded check={recorded} />
        </div>
      ) : (
        <p className="mt-2 text-sm text-neutral-700">
          Not checked yet. After this machine is imaged, boot it with a network
          and look at the very first Windows screen — that is the one moment
          Microsoft says out loud whether the device belongs to somebody.
        </p>
      )}

      {canRecord && !open && (
        <button
          onClick={() => setOpen(true)}
          className="mt-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
        >
          {recorded ? 'Record a new check' : 'Record what the screen showed'}
        </button>
      )}

      {canRecord && open && (
        <div className="mt-3 space-y-3">
          <fieldset>
            <legend className="text-sm font-medium text-neutral-900">
              What did the first Windows screen show?
            </legend>
            <div className="mt-1 space-y-1">
              {(Object.keys(SEEN) as OobeResult[]).map((k) => (
                <label key={k} className="flex gap-2 text-sm">
                  <input
                    type="radio"
                    name="oobe-result"
                    value={k}
                    checked={result === k}
                    onChange={() => setResult(k)}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">{SEEN[k].label}</span>
                    <span className="block text-xs text-neutral-600">
                      {SEEN[k].hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {result === 'organisation' && (
            <div className="space-y-2">
              <label className="block text-sm">
                <span className="font-medium">
                  The organisation it named
                </span>
                <input
                  value={organisation}
                  onChange={(e) => setOrganisation(e.target.value)}
                  maxLength={200}
                  placeholder="as it appeared on screen"
                  className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
                />
                <span className="mt-1 block text-xs text-neutral-600">
                  This is the single most useful fact on the record for getting
                  the device released.
                </span>
              </label>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={photographed}
                  onChange={(e) => setPhotographed(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  I photographed the screen
                  <span className="block text-xs text-neutral-600">
                    Microsoft&apos;s deregistration process asks for this
                    screenshot by name. Take it before the machine is touched
                    again.
                  </span>
                </span>
              </label>
            </div>
          )}

          {result === 'blocked' && (
            <label className="block text-sm">
              <span className="font-medium">Why not?</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={300}
                placeholder="no network at setup, would not boot, not imaged…"
                className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
            </label>
          )}

          <label className="block text-sm">
            <span className="font-medium">Note (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              onClick={submit}
              disabled={busy || !result}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Recording…' : 'Record'}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              disabled={busy}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-800"
            >
              Cancel
            </button>
            {error && (
              <span role="alert" className="text-xs text-red-700">
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
