// Renders the auto-captured hardware profile (assets.hardware_profile JSONB).
// Deliberately generic: it walks whatever the audit tool sent, so new fields
// added to the capture script show up here with no frontend change. Read-only —
// this is machine-captured data, kept separate from the editable warehouse fields.
//
// Two exceptions to "generic", both machine records that read as pure jargon if
// dumped: each drive's health (contract C5) is shown up front as a percentage
// and a status in words by lib/drive-health.ts, and the technician Hardware Test
// (contract C6) is shown as a clean per-component summary by lib/hardware-test.ts
// - the same formatters the reports use - rather than as JSON blobs.

import { driveHealthView, type DriveHealthView } from '@/lib/drive-health';
import { hardwareTestView, type HwTestTone } from '@/lib/hardware-test';

const CATEGORY_LABELS: Record<string, string> = {
  identification: 'Identification',
  system: 'System & firmware',
  cpu: 'Processor',
  memory: 'Memory',
  storage: 'Storage',
  graphics: 'Graphics',
  display: 'Display',
  battery: 'Battery',
  network: 'Network',
  security: 'Security',
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

// Singular label for each element of an array-valued category.
const ITEM_LABELS: Record<string, string> = { storage: 'Drive', graphics: 'GPU' };

// Keys whose humanized form isn't just Title-Cased words.
const KEY_LABELS: Record<string, string> = {
  cpu: 'CPU',
  biosUuid: 'BIOS UUID',
  biosVersion: 'BIOS version',
  biosReleaseDate: 'BIOS release date',
  bootMode: 'Boot mode',
  tpm: 'TPM',
  tpmVersion: 'TPM version',
  macAddress: 'MAC address',
  vram: 'VRAM',
  smartStatus: 'SMART status',
  powerOnHours: 'Power-on hours',
  powerCycles: 'Power cycles',
  reallocatedSectors: 'Reallocated sectors',
  pendingSectors: 'Pending sectors',
  ssdLifeUsedPct: 'SSD life used (%)',
  totalGb: 'Total (GB)',
  // Present only when the OS reported less than is installed, because the
  // firmware reserved some for integrated graphics. Total is the real capacity.
  detectedGb: 'Reported by OS (GB)',
  maxGb: 'Max (GB)',
  expressServiceCode: 'Express service code',
  serialNumber: 'Serial number',
  serviceTag: 'Service tag',
  os: 'OS',
  osVersion: 'OS version',
  osBuild: 'OS build',
  productName: 'Product name',
  productFamily: 'Product family',
  deviceType: 'Device type',
  maxClock: 'Max clock',
  baseClock: 'Base clock',
  cycleCount: 'Cycle count',
  designCapacity: 'Design capacity',
  fullChargeCapacity: 'Full charge capacity',
  secureBoot: 'Secure Boot',
  bitlocker: 'BitLocker',
  biosPassword: 'BIOS password',
  assetTag: 'Asset tag',
  refreshRate: 'Refresh rate',
};

function humanize(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Drive keys the walker must not print as-is:
//   health     - shown by DriveHealthCard instead of as a JSON blob;
//   healthPct  - the pre-C5 engine's single-attribute wear figure. It was
//                computed differently, and printed next to the real percentage
//                it would read as a second, contradicting health score.
const DRIVE_HIDDEN = new Set(['health', 'healthPct']);

// A legacy smartStatus of "unknown" is not a health result anyone can act on;
// PASSED / FAILED (the drive's own verdict) still are.
function driveEntryShown(k: string, v: unknown): boolean {
  if (DRIVE_HIDDEN.has(k)) return false;
  if (k === 'smartStatus') return typeof v === 'string' && /pass|fail/i.test(v);
  return true;
}

const HEALTH_TONE: Record<DriveHealthView['tone'], string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  bad: 'border-red-200 bg-red-50 text-red-900',
  neutral: 'border-neutral-200 bg-white text-neutral-800',
};

// The drive's health, prominently: "94% · Good" in words (never colour alone),
// what it is based on, and the key numbers the station read.
function DriveHealthCard({ drive }: { drive: unknown }) {
  const v = driveHealthView(drive);
  return (
    <div className={`mb-2 rounded-md border p-2 ${HEALTH_TONE[v.tone]}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide opacity-80">Drive health</div>
      <div
        className={
          v.kind === 'measured'
            ? 'text-lg font-semibold tabular-nums'
            : 'text-sm font-semibold'
        }
      >
        {v.headline}
      </div>
      {v.basis && <div className="text-xs">Based on: {v.basis}</div>}
      {v.action && <div className="text-xs">What to do: {v.action}</div>}
      {v.legacySmartFailed && (
        <div className="text-xs font-semibold">An earlier scan reported SMART FAILED.</div>
      )}
      {v.facts.length > 0 && (
        <div className="mt-1 text-xs tabular-nums">{v.facts.join(' · ')}</div>
      )}
      {v.reasons.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-xs">
          {v.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The same tone->class map drive health uses, so a "Passed" here reads the same
// as a "Good" drive beside it. Colour is only ever a hint: the word is always shown.
const HWT_TONE: Record<HwTestTone, string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  bad: 'border-red-200 bg-red-50 text-red-900',
  neutral: 'border-neutral-200 bg-white text-neutral-700',
};

function HwtBadge({ label, tone }: { label: string; tone: HwTestTone }) {
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${HWT_TONE[tone]}`}>
      {label}
    </span>
  );
}

// The technician Hardware Test (contract C6) as a human summary: an overall
// badge in colour AND words, who ran it and when, then one plain line per
// component. Renders nothing when the device has no test on record. Deliberately
// never prints the stored jargon (audio mixer/sink, missing-key lists, colour
// swatches, raw booleans) or the history log - hardwareTestView drops all of it.
function HardwareTestCard({ test }: { test: unknown }) {
  const v = hardwareTestView(test);
  if (!v.present) return null;
  return (
    <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Hardware functional test
        </h3>
        <HwtBadge label={v.overall.label} tone={v.overall.tone} />
      </div>
      {v.meta && <div className="mt-1 text-xs text-neutral-500">{v.meta}</div>}
      <ul className="mt-3 space-y-1.5">
        {v.rows.map((row) => (
          <li key={row.component} className="flex items-baseline justify-between gap-4 text-sm">
            <div className="min-w-0">
              <span className="font-medium text-neutral-800">{row.component}</span>
              {row.summary && <span className="text-neutral-500"> — {row.summary}</span>}
            </div>
            <HwtBadge label={row.statusLabel} tone={row.tone} />
          </li>
        ))}
      </ul>
      {v.earlierCount > 0 && (
        <div className="mt-2 text-xs text-neutral-400">
          {v.earlierCount} earlier result{v.earlierCount === 1 ? '' : 's'} on record
        </div>
      )}
    </div>
  );
}

function KVRows({ obj, drive = false }: { obj: Record<string, unknown>; drive?: boolean }) {
  const entries = Object.entries(obj).filter(
    ([k, v]) => v != null && v !== '' && (!drive || driveEntryShown(k, v)),
  );
  if (entries.length === 0) return null;
  return (
    <dl className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 text-sm">
          <dt className="shrink-0 text-neutral-500">{humanize(k)}</dt>
          <dd className="text-right text-neutral-900 break-all">{formatValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function CategoryCard({ name, value }: { name: string; value: unknown }) {
  const title = CATEGORY_LABELS[name] ?? humanize(name);

  let body: React.ReactNode = null;
  if (Array.isArray(value)) {
    const itemLabel = ITEM_LABELS[name] ?? 'Item';
    const items = value.filter((el) => el && typeof el === 'object');
    if (items.length === 0) return null;
    body = (
      <div className="space-y-3">
        {items.map((el, i) => (
          <div key={i} className="rounded-md border border-neutral-200 p-2">
            <div className="mb-1 text-xs font-medium text-neutral-500">
              {itemLabel} {i + 1}
            </div>
            {name === 'storage' && <DriveHealthCard drive={el} />}
            <KVRows obj={el as Record<string, unknown>} drive={name === 'storage'} />
          </div>
        ))}
      </div>
    );
  } else if (value && typeof value === 'object') {
    body = <KVRows obj={value as Record<string, unknown>} />;
    if (Object.values(value as Record<string, unknown>).every((v) => v == null || v === '')) {
      return null;
    }
  } else {
    body = <div className="text-sm text-neutral-900">{formatValue(value)}</div>;
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {body}
    </div>
  );
}

export function HardwareSection({ profile }: { profile: Record<string, unknown> | null | undefined }) {
  if (!profile || Object.keys(profile).length === 0) return null;

  const known = CATEGORY_ORDER.filter((k) => k in profile);
  // `locks` has its own section above. The generic walker would render it as a
  // nested blob of arrays, burying the one part of the profile someone makes a
  // buying decision on. `driveHealth` is the old kiosk's unprivileged SMART
  // probe, grafted onto profiles before C5: it ran without root, so it mostly
  // reads "unknown" - superseded by each drive's own health above.
  // `hardwareTest` is the technician functional test (contract C6): the walker
  // would print its audio-mixer commands, missing-key lists, colour swatches and
  // history log verbatim, so it is shown only by HardwareTestCard below.
  const extra = Object.keys(profile).filter(
    (k) =>
      !CATEGORY_ORDER.includes(k) &&
      k !== 'locks' &&
      k !== 'driveHealth' &&
      k !== 'hardwareTest',
  );
  const ordered = [...known, ...extra];

  return (
    <section className="md:col-span-2 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">Hardware profile</h2>
        <span className="text-xs text-neutral-500">Auto-captured · read-only</span>
      </div>
      {/* The technician functional test, shown up front as its own summary rather
          than dumped into the auto-captured grid below (it renders nothing when
          there is no test on record). */}
      <HardwareTestCard test={profile.hardwareTest} />
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((cat) => (
          <CategoryCard key={cat} name={cat} value={profile[cat]} />
        ))}
      </div>
    </section>
  );
}
