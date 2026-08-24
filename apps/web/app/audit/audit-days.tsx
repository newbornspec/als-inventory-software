'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatLabel } from '@/lib/asset-options';
import { ComponentSpecsTable } from '@/app/components/component-specs';
import {
  promotedSpecRows,
  specRows,
  type HardwareProfileLike,
  type PromotedSpec,
} from '@/lib/hardware-spec';

export interface AuditDaySummary {
  day: string; // YYYY-MM-DD
  devices: number;
  events: number;
}

interface AuditEvent {
  id: string;
  at: string;
  auditStatus: string | null;
  cosmeticGrade: string | null;
  dataWipeStatus: string | null;
  dataWipeMethod: string | null;
  restoreImageStatus: string | null;
  restoreImageName: string | null;
  auditKind: string | null;
  notes: string | null;
  auditor: string | null;
}

interface AuditDayDevice {
  assetId: string;
  name: string;
  tag: string;
  unitId: string | null;
  serialNumber: string | null;
  deviceType: string | null;
  firstAt: string;
  lastAt: string;
  auditStatus: string | null;
  cosmeticGrade: string | null;
  dataWipeStatus: string | null;
  dataWipeMethod: string | null;
  auditKind: string | null;
  restoreImageStatus: string | null;
  restoreImageName: string | null;
  auditors: string[];
  // The components as the day's audit events recorded them — the trail's own
  // snapshot, not the device's current profile.
  spec?: (PromotedSpec & { hardwareProfile: HardwareProfileLike | null }) | null;
  events: AuditEvent[];
}

// Semantic tint for an outcome chip. Neutral by default — colour is reserved
// for genuinely good/bad outcomes so a wall of power_on doesn't read as 12
// alarms.
function chipClass(value: string): string {
  const bad = ['failed_testing', 'no_power', 'post_failed', 'data_wipe_failed', 'ber', 'failed'];
  const good = ['passed_testing', 'ready_for_sale', 'refurbished', 'data_wiped', 'wiped', 'installed'];
  if (bad.includes(value)) return 'bg-red-50 text-red-800 border-red-200';
  if (good.includes(value)) return 'bg-emerald-50 text-emerald-800 border-emerald-200';
  return 'bg-neutral-100 text-neutral-700 border-neutral-200';
}

function Chip({ value }: { value: string }) {
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${chipClass(value)}`}>
      {formatLabel(value)}
    </span>
  );
}

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function timeLabel(at: string): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// The expanded device: what was audited, laid out as the operator reads it -
// identity across the top, the component table on the left, and the audit's
// own metadata plus its operation history down the right.
//
// Everything here is the AUDIT's record, not the device's current state: if a
// machine is re-audited or re-fitted next week this panel must still show what
// the technician saw on the day. That is what makes it a trail.

// An event's outcome word. Derived from the verdict the event actually
// recorded - never invented: a value we cannot judge reads OK, not PASS.
function outcomeOf(e: AuditEvent): { word: string; tone: string } {
  const bad = ['failed_testing', 'no_power', 'post_failed', 'data_wipe_failed', 'ber'];
  const good = ['passed_testing', 'ready_for_sale', 'refurbished', 'data_wiped'];
  if (e.dataWipeStatus === 'failed' || (e.auditStatus && bad.includes(e.auditStatus))) {
    return { word: 'FAIL', tone: 'text-red-700' };
  }
  if (e.restoreImageStatus === 'installed') return { word: 'DONE', tone: 'text-emerald-700' };
  if (e.dataWipeStatus === 'wiped' || (e.auditStatus && good.includes(e.auditStatus))) {
    return { word: 'PASS', tone: 'text-emerald-700' };
  }
  return { word: 'OK', tone: 'text-neutral-500' };
}

// What the event is called: the strongest fact it carried, in the operator's
// words - not a generic "audit event".
function eventTitle(e: AuditEvent): string {
  if (e.dataWipeStatus && e.dataWipeStatus !== 'not_started') {
    return formatLabel(e.dataWipeStatus === 'wiped' ? 'data_wiped' : e.dataWipeStatus);
  }
  if (e.restoreImageStatus) return `Restore ${formatLabel(e.restoreImageStatus)}`;
  if (e.auditStatus) return formatLabel(e.auditStatus);
  if (e.cosmeticGrade) return `Graded ${formatLabel(e.cosmeticGrade)}`;
  return 'Audit recorded';
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-neutral-100 py-1.5 last:border-b-0">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-neutral-900">{children}</dd>
    </div>
  );
}

function DevicePanel({ device }: { device: AuditDayDevice }) {
  const spec = device.spec ?? null;
  const fromProfile = specRows(spec?.hardwareProfile);
  // No profile blob (an audit filed from the offline form records only the
  // promoted columns) - show what WAS recorded rather than nothing.
  const rows = fromProfile.length > 0 ? fromProfile : promotedSpecRows(spec);

  return (
    <div className="mb-2 ml-6 overflow-hidden rounded-md border border-neutral-200 bg-white">
      {/* Identity bar - the machine, its permanent tag and serial, with the
          headline verdict and the time the session ended. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
        <Link
          href={`/assets/${device.assetId}`}
          className="text-sm font-semibold text-neutral-900 underline decoration-neutral-300 hover:decoration-neutral-900"
        >
          {device.name}
        </Link>
        <span className="text-xs text-neutral-500">
          Asset tag:{' '}
          <span className="font-mono text-neutral-700">{device.unitId ?? device.tag}</span>
        </span>
        <span className="text-xs text-neutral-500">
          Serial:{' '}
          <span className="font-mono text-neutral-700">{device.serialNumber ?? '—'}</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          {device.auditStatus && <Chip value={device.auditStatus} />}
          <span className="text-xs text-neutral-500">Audit time: {timeLabel(device.lastAt)}</span>
        </span>
      </div>

      <div className="grid gap-4 p-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          {rows.length === 0 ? (
            <>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">
                Component specification metrics
              </h3>
              <p className="mt-2 text-sm text-neutral-500">
                No hardware captured with this audit
                {spec?.hardwareProfile == null &&
                  ' — it was filed by hand, or by a tool that sends none'}
                .{' '}
                <Link
                  href={`/assets/${device.assetId}`}
                  className="text-blue-800 underline hover:text-blue-950"
                >
                  Open the device record
                </Link>
              </p>
            </>
          ) : (
            <ComponentSpecsTable
              rows={rows}
              caption={`Components recorded for ${device.unitId ?? device.tag} on this day`}
            />
          )}
        </div>

        <div className="space-y-4">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">
              System metadata
            </h3>
            <dl className="mt-1">
              <MetaRow label="Auditor">
                {device.auditors.length ? device.auditors.join(', ') : '—'}
              </MetaRow>
              <MetaRow label="Workflow">
                {device.auditKind ? (
                  formatLabel(device.auditKind)
                ) : (
                  <span className="font-normal text-neutral-500">Unclassified</span>
                )}
              </MetaRow>
              <MetaRow label="Cosmetic">
                {device.cosmeticGrade ? (
                  <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">
                    {formatLabel(device.cosmeticGrade)}
                  </span>
                ) : (
                  '—'
                )}
              </MetaRow>
              <MetaRow label="Restore image">
                {device.restoreImageStatus ? (
                  <>
                    {formatLabel(device.restoreImageStatus)}
                    {device.restoreImageName && (
                      <span className="ml-1 font-normal text-neutral-600">
                        {device.restoreImageName}
                      </span>
                    )}
                  </>
                ) : (
                  // "Not recorded" - never "not restored": most events predate
                  // the kiosk reporting installs, and old sticks keep filing
                  // without it.
                  <span className="font-normal text-neutral-500">Not recorded</span>
                )}
              </MetaRow>
            </dl>
            {device.dataWipeStatus && (
              <p className="mt-2 rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs text-neutral-700">
                <span className="font-medium">Data wipe: </span>
                {formatLabel(device.dataWipeStatus)}
                {device.dataWipeMethod && ` — ${device.dataWipeMethod}`}
              </p>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">
              Operation history{' '}
              <span className="font-normal normal-case tracking-normal text-neutral-400">
                ({device.events.length})
              </span>
            </h3>
            <ul className="mt-1 space-y-1">
              {device.events.map((e) => {
                const outcome = outcomeOf(e);
                return (
                  <li
                    key={e.id}
                    className="flex items-start justify-between gap-3 rounded border border-neutral-200 px-2 py-1.5"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-neutral-900">
                        {eventTitle(e)}
                      </span>
                      <span className="block text-xs text-neutral-500">
                        {e.auditor ?? '—'} · {timeLabel(e.at)}
                      </span>
                      {e.notes && (
                        <span className="mt-0.5 block text-xs text-neutral-600">{e.notes}</span>
                      )}
                    </span>
                    <span className={`shrink-0 text-xs font-semibold ${outcome.tone}`}>
                      {outcome.word}
                    </span>
                  </li>
                );
              })}
              {device.events.length === 0 && (
                <li className="text-sm text-neutral-500">No events.</li>
              )}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

export function AuditDays({ days, kind }: { days: AuditDaySummary[]; kind?: string }) {
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());
  const [openDevices, setOpenDevices] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Record<string, AuditDayDevice[] | 'loading' | 'error'>>({});

  function toggleDay(day: string) {
    setOpenDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
    if (!cache[day]) {
      setCache((c) => ({ ...c, [day]: 'loading' }));
      fetch(`/api/audits/days/${day}${kind ? `?kind=${kind}` : ''}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((devices: AuditDayDevice[]) => setCache((c) => ({ ...c, [day]: devices })))
        .catch(() => setCache((c) => ({ ...c, [day]: 'error' })));
    }
  }

  function toggleDevice(key: string) {
    setOpenDevices((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="mt-4 divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white">
      {days.map(({ day, devices, events }) => {
        const open = openDays.has(day);
        const loaded = cache[day];
        return (
          <section key={day}>
            <h2 className="m-0">
              <button
                type="button"
                onClick={() => toggleDay(day)}
                aria-expanded={open}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50"
              >
                {open ? (
                  <ChevronDown className="size-4 shrink-0 text-neutral-500" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-neutral-500" aria-hidden="true" />
                )}
                <span className="text-sm font-semibold text-neutral-950">{dayLabel(day)}</span>
                <span className="ml-auto text-sm text-neutral-600">
                  {devices} {devices === 1 ? 'device' : 'devices'}
                  <span className="text-neutral-600"> · {events} {events === 1 ? 'event' : 'events'}</span>
                </span>
              </button>
            </h2>

            {open && (
              <div className="border-t border-neutral-100 bg-neutral-50/50 px-4 py-2">
                {loaded === 'loading' && (
                  <p className="py-2 text-sm text-neutral-500">Loading…</p>
                )}
                {loaded === 'error' && (
                  <p className="py-2 text-sm text-red-700">
                    Couldn&rsquo;t load this day — reload the page to try again.
                  </p>
                )}
                {Array.isArray(loaded) && (
                  <ul className="divide-y divide-neutral-100">
                    {loaded.map((d) => {
                      const key = `${day}:${d.assetId}`;
                      const deviceOpen = openDevices.has(key);
                      return (
                        <li key={key} className="py-1">
                          <button
                            type="button"
                            onClick={() => toggleDevice(key)}
                            aria-expanded={deviceOpen}
                            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded px-1 py-1.5 text-left hover:bg-white"
                          >
                            {deviceOpen ? (
                              <ChevronDown className="size-3.5 shrink-0 text-neutral-400" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="size-3.5 shrink-0 text-neutral-400" aria-hidden="true" />
                            )}
                            <span className="text-sm font-medium text-neutral-900">{d.name}</span>
                            <span className="font-mono text-xs text-neutral-500">
                              {d.unitId ?? d.tag}
                            </span>
                            <span className="ml-auto flex items-center gap-1.5">
                              {d.auditStatus && <Chip value={d.auditStatus} />}
                              {d.dataWipeStatus && d.dataWipeStatus !== 'not_started' && (
                                <Chip value={d.dataWipeStatus} />
                              )}
                              <span className="text-xs text-neutral-500">{timeLabel(d.lastAt)}</span>
                            </span>
                          </button>

                          {deviceOpen && <DevicePanel device={d} />}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
