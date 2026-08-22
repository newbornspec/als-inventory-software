'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatLabel } from '@/lib/asset-options';

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
  auditors: string[];
  events: AuditEvent[];
}

// Semantic tint for an outcome chip. Neutral by default — colour is reserved
// for genuinely good/bad outcomes so a wall of power_on doesn't read as 12
// alarms.
function chipClass(value: string): string {
  const bad = ['failed_testing', 'no_power', 'post_failed', 'data_wipe_failed', 'ber', 'failed'];
  const good = ['passed_testing', 'ready_for_sale', 'refurbished', 'data_wiped', 'wiped'];
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

export function AuditDays({ days }: { days: AuditDaySummary[] }) {
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
      fetch(`/api/audits/days/${day}`)
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
    <div className="mt-6 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
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
                  <span className="text-neutral-400"> · {events} {events === 1 ? 'event' : 'events'}</span>
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

                          {deviceOpen && (
                            <div className="mb-2 ml-6 rounded-md border border-neutral-200 bg-white p-3">
                              <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
                                <div>
                                  <dt className="text-xs text-neutral-500">Device</dt>
                                  <dd>
                                    <Link
                                      href={`/assets/${d.assetId}`}
                                      className="text-blue-800 underline hover:text-blue-950"
                                    >
                                      {d.name}
                                    </Link>
                                  </dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-neutral-500">Serial</dt>
                                  <dd className="font-mono text-xs">{d.serialNumber ?? '—'}</dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-neutral-500">Auditor</dt>
                                  <dd>{d.auditors.length ? d.auditors.join(', ') : '—'}</dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-neutral-500">Audit status</dt>
                                  <dd>{d.auditStatus ? <Chip value={d.auditStatus} /> : '—'}</dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-neutral-500">Cosmetic grade</dt>
                                  <dd>{d.cosmeticGrade ? formatLabel(d.cosmeticGrade) : '—'}</dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-neutral-500">Data wipe</dt>
                                  <dd>
                                    {d.dataWipeStatus ? (
                                      <>
                                        <Chip value={d.dataWipeStatus} />
                                        {d.dataWipeMethod && (
                                          <span className="ml-1.5 text-xs text-neutral-600">
                                            {d.dataWipeMethod}
                                          </span>
                                        )}
                                      </>
                                    ) : (
                                      '—'
                                    )}
                                  </dd>
                                </div>
                                <div>
                                  {/* Captured by the Audit Station but not yet
                                      reported to the server — lights up when the
                                      kiosk upload ships. Shown so the column's
                                      absence reads as "not recorded", never as
                                      "not restored". */}
                                  <dt className="text-xs text-neutral-500">Restore image</dt>
                                  <dd className="text-neutral-500">Not recorded</dd>
                                </div>
                              </dl>

                              <h3 className="mt-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
                                Events ({d.events.length})
                              </h3>
                              <ul className="mt-1 divide-y divide-neutral-100 text-sm">
                                {d.events.map((e) => (
                                  <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                                    <span className="font-mono text-xs text-neutral-500">{timeLabel(e.at)}</span>
                                    {e.auditStatus && <Chip value={e.auditStatus} />}
                                    {e.dataWipeStatus && e.dataWipeStatus !== 'not_started' && (
                                      <Chip value={e.dataWipeStatus} />
                                    )}
                                    {e.cosmeticGrade && (
                                      <span className="text-xs text-neutral-600">
                                        {formatLabel(e.cosmeticGrade)}
                                      </span>
                                    )}
                                    {e.notes && (
                                      <span className="text-xs text-neutral-600">{e.notes}</span>
                                    )}
                                    <span className="ml-auto text-xs text-neutral-500">
                                      {e.auditor ?? '—'}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
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
