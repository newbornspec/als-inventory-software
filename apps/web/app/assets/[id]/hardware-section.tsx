// The asset page's Hardware Profile section (assets.hardware_profile JSONB),
// laid out the way the owner designed it: a device header bar, a grid of titled
// cards with Parameter/Value tables, and a Hardware Test Results table.
//
// The rule the whole file obeys: never claim what was not measured. Every row is
// fed by ONE named profile field. Anything the capture tool does not record
// renders the design's em-dash "—" — never a guess, never a filled-in blank, and
// never the word "Unknown" (a stored literal "unknown" is treated as no answer
// at all). Colour is never the only signal: every tinted cell carries the word
// too, so a greyscale print of this page reads identically (WCAG 1.4.1).
//
// Two pieces of wording are deliberately NOT decided here. Each drive's health
// (contract C5) is worded by lib/drive-health.ts, and the technician Hardware
// Test (contract C6) by lib/hardware-test.ts — the same formatters the xlsx
// reports use, so one device cannot read "Passed" on this page and "Failed" in
// an export. Both files are byte-locked to their apps/api twins by a jest spec,
// so nothing new can be exported from them; the small date and audio-channel
// helpers below exist only for that reason and decide no status wording of their
// own.
//
// The generic walker that used to render the whole section is still here, now
// feeding a final "Other captured details" card: a key the capture tool starts
// sending tomorrow must still appear somewhere rather than vanish because no
// card claims it.

import type { ReactNode } from 'react';
import {
  driveHealthView,
  statusForPercent,
  STATUS_LABEL,
  type DriveHealthView,
} from '@/lib/drive-health';
import { hardwareTestView, type HardwareTestView, type HwTestTone } from '@/lib/hardware-test';
import { formatLabel } from '@/lib/asset-options';

// The design's own placeholder for a value we do not hold. One constant so it
// cannot drift into a blank cell, an "n/a" or an "Unknown" anywhere.
const DASH = '—';

// drive-health and hardware-test happen to share this union; one alias keeps a
// DriveHealthView tone and a HwTestTone assignable to the same cell.
type Tone = HwTestTone;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function subObject(profile: Obj, key: string): Obj {
  const v = profile[key];
  return isObj(v) ? v : {};
}

function subArray(profile: Obj, key: string): Obj[] {
  const v = profile[key];
  return Array.isArray(v) ? v.filter(isObj) : [];
}

// A captured value as a human string, or DASH when there is nothing to show.
// A stored "unknown" is not an answer — the station uses it as a placeholder,
// and the house rule is that the word never reaches an operator's screen.
function text(v: unknown): string {
  if (v == null) return DASH;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : DASH;
  if (typeof v !== 'string') return DASH;
  const t = v.trim();
  if (!t || /^unknown$/i.test(t)) return DASH;
  // The firmware answers in lower case ("yes", "enabled"); a capital reads as
  // a value rather than as a fragment of a sentence.
  if (/^(yes|no|enabled|disabled|present|absent|none)$/i.test(t)) {
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }
  return t;
}

// True when text() found something real — used to decide whether a value exists
// at all, without repeating the "unknown"/empty rules.
function has(v: unknown): boolean {
  return text(v) !== DASH;
}

// A captured number with its unit, e.g. 16 -> "16 GB". DASH when absent, so a
// unit is never printed next to nothing.
function withUnit(v: unknown, unit: string): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DASH;
  return `${v} ${unit}`;
}

// "2026-09-20T15:50:25Z" -> "20 Sep 2026", in UTC so the printed day matches the
// day the station stamped whatever timezone reads it. A copy of the formatter's
// own date rule rather than an import, because lib/hardware-test.ts is held
// byte-identical to its apps/api twin by a spec and cannot export anything new.
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function testDate(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return DASH;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* ------------------------------------------------------------------ layout */

// The value cell's soft highlight. Only ever a hint: the status word is always
// printed in the same cell, so the meaning survives greyscale and colour
// blindness.
const VALUE_TONE: Record<Tone, string> = {
  good: 'bg-emerald-50 text-emerald-900',
  warn: 'bg-amber-50 text-amber-900',
  bad: 'bg-red-50 text-red-900',
  neutral: '',
};

// The same tone -> class map the drive-health card used, so a "Passed" here
// reads like a "Good" drive beside it.
const BADGE_TONE: Record<Tone, string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  bad: 'border-red-200 bg-red-50 text-red-900',
  neutral: 'border-neutral-300 bg-white text-neutral-700',
};

function Badge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${BADGE_TONE[tone]}`}
    >
      {label}
    </span>
  );
}

interface Row {
  label: string;
  value: ReactNode;
  // Highlights the VALUE cell (health rows only). The word always goes in the
  // value itself, never in the colour alone.
  tone?: Tone;
  // A quieter second line under the value: what a health figure was based on,
  // why a test is not a pass. Never a raw stored field.
  note?: ReactNode;
}

// One card: a header bar with the title, then the design's Parameter | Value
// table. Every card wears the SAME bar colour on purpose — a per-card colour
// would read as a status ("why is Battery orange?") when it only means "this is
// a different card".
function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <h3 className="bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-white">
        {title}
      </h3>
      {children}
    </div>
  );
}

function ParamTable({ rows, caption }: { rows: Row[]; caption: string }) {
  return (
    <table className="w-full border-collapse text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="text-[11px] uppercase tracking-wide text-neutral-600">
        <tr className="border-b border-neutral-200 bg-neutral-50">
          <th scope="col" className="px-3 py-1.5 font-medium">Parameter</th>
          <th scope="col" className="px-3 py-1.5 font-medium">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-b border-neutral-100 align-top last:border-0">
            <th scope="row" className="w-2/5 px-3 py-1.5 font-normal text-neutral-600">
              {r.label}
            </th>
            <td
              className={`px-3 py-1.5 break-words text-neutral-950 ${
                r.tone ? `font-semibold ${VALUE_TONE[r.tone]}` : ''
              }`}
            >
              {r.value}
              {r.note && <span className="mt-0.5 block text-xs font-normal">{r.note}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// A card whose rows all come from the mapping above. `caption` describes the
// table for a screen reader, which cannot see the header bar as a heading.
function TableCard({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <Card title={title}>
      <ParamTable rows={rows} caption={`${title} — captured values for this device`} />
    </Card>
  );
}

/* ------------------------------------------------------- the device header */

// What the warehouse record knows about the device, as opposed to what the
// machine reported about itself. Status and Last updated cannot come from the
// profile — they are ours, not the hardware's — so the page passes them in.
export interface HardwareDeviceHeader {
  status?: string | null;
  assetTag?: string | null;
  updatedAt?: string | null;
}

// Stock status as colour AND word. Deliberately conservative: only a status
// that genuinely reads as a problem is amber, and a device that has left
// inventory is neutral rather than green. The word is what carries the meaning.
function statusTone(status: string): Tone {
  if (status === 'quarantined' || status === 'disposed') return 'warn';
  if (['in_stock', 'audited', 'allocated', 'picked', 'packed', 'shipped'].includes(status)) {
    return 'good';
  }
  return 'neutral';
}

function HeaderFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-neutral-300">{label}</dt>
      <dd className="truncate text-sm font-medium text-white" title={typeof value === 'string' ? value : undefined}>
        {value}
      </dd>
    </div>
  );
}

function DeviceHeader({ ident, device }: { ident: Obj; device?: HardwareDeviceHeader }) {
  const maker = text(ident.manufacturer);
  const model = text(ident.model);
  const name = [maker, model].filter((p) => p !== DASH).join(' ') || DASH;
  const status = device?.status ? device.status.trim() : '';
  // The SMBIOS asset tag if the machine carries one, otherwise our own printed
  // tag — both are real recorded values, neither is a guess.
  const tag = has(ident.assetTag) ? text(ident.assetTag) : text(device?.assetTag);
  const updated =
    device?.updatedAt && !Number.isNaN(new Date(device.updatedAt).getTime())
      ? new Date(device.updatedAt).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : DASH;

  return (
    <div className="mt-3 rounded-lg bg-neutral-900 px-4 py-3">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <HeaderFact label="Device" value={name} />
        <HeaderFact
          label="Status"
          value={
            status ? (
              <Badge label={formatLabel(status)} tone={statusTone(status)} />
            ) : (
              DASH
            )
          }
        />
        <HeaderFact label="Serial number" value={text(ident.serialNumber)} />
        <HeaderFact label="Asset tag" value={tag} />
        <HeaderFact label="Device type" value={text(ident.deviceType)} />
        <HeaderFact label="Last updated" value={updated} />
      </dl>
    </div>
  );
}

/* --------------------------------------------------------------- the cards */

function hardwareInformationRows(ident: Obj): Row[] {
  return [
    { label: 'Manufacturer', value: text(ident.manufacturer) },
    { label: 'Model', value: text(ident.model) },
    { label: 'Product name', value: text(ident.productName) },
    { label: 'System family', value: text(ident.productFamily) },
    { label: 'Serial number', value: text(ident.serialNumber) },
    { label: 'Service tag', value: text(ident.serviceTag) },
    { label: 'Express service code', value: text(ident.expressServiceCode) },
    { label: 'Asset tag', value: text(ident.assetTag) },
    { label: 'Chassis type', value: text(ident.deviceType) },
    { label: 'UUID', value: text(ident.biosUuid) },
    // Nothing in the capture reads a manufacture date. The design asks for the
    // row, so it stays — empty and honest.
    { label: 'Manufacture date', value: DASH },
  ];
}

// The health engine writes each figure twice: inside the C5 `health` object and
// as a flat key on the drive, kept for readers that predate C5. Same engine,
// same reading — printing both would read as two measurements that happen to
// agree, so the card takes the C5 value and falls back to the flat twin.
function driveNumber(drive: Obj, health: Obj, key: string, flatKey: string): unknown {
  return health[key] ?? drive[flatKey];
}

function storageRows(drive: Obj, view: DriveHealthView): Row[] {
  const health = isObj(drive.health) ? drive.health : {};
  const temp = driveNumber(drive, health, 'temperatureC', 'temperatureC');
  const lifeUsed = driveNumber(drive, health, 'lifeUsedPct', 'ssdLifeUsedPct');

  // The percentage, the status word and every deduction behind them come from
  // driveHealthView — the C5 contract's wording, identical to the xlsx reports.
  const healthNote: ReactNode = (
    <>
      {view.basis && <span className="block">Based on: {view.basis}</span>}
      {view.action && <span className="block">What to do: {view.action}</span>}
      {view.reasons.length > 0 && <span className="block">{view.reasons.join(' · ')}</span>}
      {view.legacySmartFailed && (
        <span className="block font-semibold">An earlier scan reported SMART FAILED.</span>
      )}
    </>
  );

  return [
    { label: 'Drive model', value: text(drive.model) },
    { label: 'Drive type', value: text(drive.type) },
    { label: 'Capacity', value: text(drive.capacity) },
    { label: 'Interface', value: text(drive.interface) },
    { label: 'Serial number', value: text(drive.serialNumber) },
    {
      label: 'SMART status',
      // A legacy smartStatus of "unknown" is not a result anyone can act on;
      // the drive's own PASSED / FAILED verdict still is.
      value:
        typeof drive.smartStatus === 'string' && /pass|fail/i.test(drive.smartStatus)
          ? text(drive.smartStatus)
          : DASH,
    },
    {
      label: 'Health status',
      value: view.cell,
      tone: view.tone,
      note: healthNote,
    },
    { label: 'Power on hours', value: withUnit(driveNumber(drive, health, 'powerOnHours', 'powerOnHours'), 'h') },
    { label: 'Power cycles', value: text(driveNumber(drive, health, 'powerCycles', 'powerCycles')) },
    { label: 'Temperature', value: withUnit(temp, '°C') },
    { label: 'SSD life used', value: typeof lifeUsed === 'number' ? `${lifeUsed}%` : DASH },
    // The capture reads the drive, not its filesystems: it never mounts a
    // partition, so there is no used/free figure and no partition list.
    { label: 'Used space', value: DASH },
    { label: 'Free space', value: DASH },
    { label: 'Partitions', value: DASH },
  ];
}

function biosRows(system: Obj, ident: Obj): Row[] {
  return [
    { label: 'BIOS version', value: text(system.biosVersion) },
    { label: 'BIOS release date', value: text(system.biosReleaseDate) },
    { label: 'UEFI / boot mode', value: text(system.bootMode) },
    { label: 'Secure Boot', value: text(system.secureBoot) },
    { label: 'TPM version', value: text(system.tpmVersion) },
    { label: 'System manufacturer', value: text(ident.manufacturer) },
    // Neither the embedded controller nor the Management Engine firmware
    // revision is read by the capture tool.
    { label: 'Embedded controller', value: DASH },
    { label: 'ME firmware', value: DASH },
  ];
}

function processorRows(cpu: Obj): Row[] {
  const cores = typeof cpu.cores === 'number' ? `${cpu.cores} Cores` : '';
  const threads = typeof cpu.threads === 'number' ? `${cpu.threads} Threads` : '';
  const both = [cores, threads].filter(Boolean).join(' / ');
  return [
    { label: 'CPU', value: text(cpu.model) },
    { label: 'Manufacturer', value: text(cpu.manufacturer) },
    { label: 'Generation', value: text(cpu.generation) },
    { label: 'Cores / threads', value: both || DASH },
    { label: 'Base speed', value: text(cpu.baseClock) },
    { label: 'Max speed', value: text(cpu.maxClock) },
    // Whether VT-x/AMD-V is enabled in firmware is not read by the capture.
    { label: 'Virtualization', value: DASH },
  ];
}

function displayRows(display: Obj): Row[] {
  return [
    { label: 'Size', value: text(display.size) },
    { label: 'Resolution', value: text(display.resolution) },
    { label: 'Refresh rate', value: text(display.refreshRate) },
    { label: 'Touchscreen', value: text(display.touchscreen) },
    // The panel's EDID gives size and resolution; it is not decoded far enough
    // to name the panel technology or its maker.
    { label: 'Panel type', value: DASH },
    { label: 'Manufacturer', value: DASH },
  ];
}

function operatingSystemRows(system: Obj): Row[] {
  return [
    { label: 'OS name', value: text(system.os) },
    { label: 'Version', value: text(system.osVersion) },
    { label: 'Build', value: text(system.osBuild) },
    // The audit boots the machine from our own live stick, so nothing here can
    // report the installed OS's architecture, install date or licence.
    { label: 'Architecture', value: DASH },
    { label: 'Installation date', value: DASH },
    { label: 'Product ID', value: DASH },
    { label: 'Windows Experience Index', value: DASH },
  ];
}

function memoryRows(memory: Obj): Row[] {
  const modules = typeof memory.modules === 'number' ? memory.modules : null;
  const slots = typeof memory.slots === 'number' ? memory.slots : null;
  let fitted = DASH;
  if (modules != null && slots != null) fitted = `${modules} of ${slots}`;
  else if (modules != null) fitted = String(modules);
  else if (slots != null) fitted = `${slots} slots`;

  const rows: Row[] = [
    { label: 'Type', value: text(memory.type) },
    { label: 'Total size', value: withUnit(memory.totalGb, 'GB') },
    { label: 'Speed', value: text(memory.speed) },
    { label: 'Modules / slots', value: fitted },
    { label: 'Max supported', value: withUnit(memory.maxGb, 'GB') },
  ];
  // Only when the OS saw less than is installed, because firmware reserved some
  // for integrated graphics. Total above is the real capacity; this is the
  // diagnostic, and printing it when the two agree invites the wrong reading.
  if (typeof memory.detectedGb === 'number' && memory.detectedGb !== memory.totalGb) {
    rows.push({ label: 'Reported by OS', value: withUnit(memory.detectedGb, 'GB') });
  }
  rows.push({ label: 'Manufacturer', value: DASH });
  return rows;
}

function graphicsRows(gpus: Obj[]): Row[] {
  const rows: Row[] = [];
  gpus.forEach((g, i) => {
    // The first GPU wears the design's plain labels; later ones are prefixed so
    // two "Manufacturer" rows cannot be confused in one table.
    const prefix = i === 0 ? '' : `GPU ${i + 1} `;
    rows.push({ label: `GPU ${i + 1}`, value: text(g.model) });
    rows.push({ label: `${prefix}Manufacturer`, value: text(g.manufacturer) });
    rows.push({ label: `${prefix}Type`, value: text(g.type) });
    rows.push({ label: `${prefix}Video memory`, value: text(g.vram) });
  });
  if (gpus.length === 0) rows.push({ label: 'GPU 1', value: 'Not detected' });
  // The design lists a second GPU; a machine with one card says so plainly
  // rather than leaving the reader to wonder whether we looked.
  if (gpus.length === 1) rows.push({ label: 'GPU 2', value: 'Not detected' });
  // Driver versions and shared-memory figures belong to a running Windows
  // install; the audit boots its own OS and never sees them.
  rows.push({ label: 'Driver version', value: DASH });
  rows.push({ label: 'Shared memory', value: DASH });
  return rows;
}

// The stored battery health is a bare percentage ("87%"): full-charge capacity
// over design capacity, as the firmware reports it. The band it falls in comes
// from drive-health's published owner bands (Good 90-100, Caution 50-89, Bad
// 0-49) rather than a second scale invented here, and the word is printed
// beside the number so the tint is never the only signal. A health string that
// carries no percentage is shown untinted and unlabelled — we will not band
// what we cannot read.
function batteryHealthRow(battery: Obj): Row {
  const raw = text(battery.health);
  if (raw === DASH) return { label: 'Health', value: DASH };
  const match = /(\d+(?:\.\d+)?)\s*%/.exec(raw);
  const percent = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { label: 'Health', value: raw };
  }
  const status = statusForPercent(Math.round(percent));
  const tone: Tone = status === 'good' ? 'good' : status === 'caution' ? 'warn' : 'bad';
  return { label: 'Health', value: `${raw} · ${STATUS_LABEL[status]}`, tone };
}

function batteryRows(battery: Obj): Row[] {
  return [
    batteryHealthRow(battery),
    { label: 'Design capacity', value: text(battery.designCapacity) },
    { label: 'Full charge capacity', value: text(battery.fullChargeCapacity) },
    { label: 'Cycle count', value: text(battery.cycleCount) },
    { label: 'Status', value: text(battery.status) },
    // sysfs gives the capacities and the cycle count, not the cell vendor or
    // its chemistry.
    { label: 'Manufacturer', value: DASH },
    { label: 'Chemistry', value: DASH },
  ];
}

function networkRows(network: Obj): Row[] {
  return [
    { label: 'Wi-Fi', value: text(network.wifi) },
    { label: 'Ethernet', value: text(network.ethernet) },
    { label: 'Bluetooth', value: text(network.bluetooth) },
    { label: 'MAC address', value: text(network.macAddress) },
  ];
}

function securityRows(security: Obj): Row[] {
  return [
    { label: 'TPM', value: text(security.tpm) },
    { label: 'Secure Boot', value: text(security.secureBoot) },
    { label: 'BitLocker', value: text(security.bitlocker) },
    { label: 'BIOS password', value: text(security.biosPassword) },
  ];
}

/* --------------------------------------------- the hardware test results */

interface TestRow {
  component: string;
  statusLabel: string;
  tone: Tone;
  details: ReactNode;
  testedOn: string;
}

// One audio channel's own outcome. The station stores it as its component
// status word ("PASSED") or as a boolean; anything else is not an outcome.
function channelWorks(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/pass|work|good|^ok$|^yes$/i.test(v)) return true;
    if (/fail|faulty|bad|dead|^no$/i.test(v)) return false;
  }
  return null;
}

// hardwareTestView returns ONE "Speaker" row, because the station runs one
// speaker test; the owner's design lists the two channels separately. The
// verdict word, the tone and the sentence all still come from the formatter —
// only the per-side Passed/Failed is read from the stored channel, which is the
// one fact a combined row cannot carry. When the speaker test did not finish,
// BOTH channels inherit the formatter's own status: a channel must never show a
// green "Passed" for a test nobody ran.
function speakerRows(view: HardwareTestView, part: Obj): TestRow[] {
  const base = view.rows.find((r) => r.component === 'Speaker');
  const fallbackLabel = base?.statusLabel ?? 'Not tested';
  const fallbackTone: Tone = base?.tone ?? 'neutral';
  const finished = fallbackTone === 'good' || fallbackTone === 'warn' || fallbackTone === 'bad';
  const testedOn = testDate(part.testedAt);

  return (['left', 'right'] as const).map((side) => {
    const works = finished ? channelWorks(part[side]) : null;
    return {
      component: side === 'left' ? 'Left speaker' : 'Right speaker',
      statusLabel: works === null ? fallbackLabel : works ? 'Passed' : 'Failed',
      tone: works === null ? fallbackTone : works ? 'good' : 'bad',
      details: base?.summary || DASH,
      testedOn,
    };
  });
}

// The five components the technician genuinely confirms, in the order the
// design lists them, with the speaker split into its two channels.
function testedRows(view: HardwareTestView, hwt: Obj): TestRow[] {
  const fromView = (component: string, key: string): TestRow => {
    const row = view.rows.find((r) => r.component === component);
    return {
      component,
      statusLabel: row?.statusLabel ?? 'Not tested',
      tone: row?.tone ?? 'neutral',
      details: row?.summary || DASH,
      testedOn: testDate(subObject(hwt, key).testedAt),
    };
  };
  return [
    fromView('Keyboard', 'keyboard'),
    fromView('Trackpad', 'trackpad'),
    ...speakerRows(view, subObject(hwt, 'speaker')),
    fromView('Camera', 'camera'),
    fromView('Screen', 'screen'),
  ];
}

// A component the capture DETECTS but nobody tests. "Detected" means the part is
// there, not that it works, so these rows are always neutral and never wear a
// Passed badge — the details line says so in as many words.
function detectionRow(component: string, adapter: unknown, absentNote: string): TestRow {
  const name = text(adapter);
  if (name === DASH) {
    return {
      component,
      statusLabel: 'Not tested',
      tone: 'neutral',
      details: absentNote,
      testedOn: DASH,
    };
  }
  return {
    component,
    statusLabel: 'Detected',
    tone: 'neutral',
    details: `${name} — present in the machine, not functionally tested`,
    testedOn: DASH,
  };
}

// The optical drive, if a profile ever carries one. Nothing in today's capture
// writes it, so this normally reads "Not tested"; it is wired up so that the day
// the tool starts recording one, the row fills itself in.
function opticalRow(profile: Obj): TestRow {
  const raw = profile.opticalDrive ?? profile.optical;
  const value = text(raw);
  const absent =
    raw === false || (value !== DASH && /^(no|none|not present|not fitted|absent)$/i.test(value));
  if (absent) {
    return {
      component: 'Optical drive',
      statusLabel: 'Not fitted',
      tone: 'neutral',
      details: 'The capture found no optical drive in this machine.',
      testedOn: DASH,
    };
  }
  if (value === DASH) {
    return {
      component: 'Optical drive',
      statusLabel: 'Not tested',
      tone: 'neutral',
      details: 'The capture tool does not record an optical drive.',
      testedOn: DASH,
    };
  }
  return {
    component: 'Optical drive',
    statusLabel: 'Detected',
    tone: 'neutral',
    details:
      raw === true || /^(yes|present)$/i.test(value)
        ? 'Present in the machine, not functionally tested'
        : `${value} — present in the machine, not functionally tested`,
    testedOn: DASH,
  };
}

const NO_TEST = 'There is no technician test for this component.';
const NO_ADAPTER = 'No adapter recorded by the capture tool.';

function untestedRows(profile: Obj): TestRow[] {
  const network = subObject(profile, 'network');
  return [
    opticalRow(profile),
    detectionRow('Network (Wi-Fi)', network.wifi, NO_ADAPTER),
    detectionRow('Network (Ethernet)', network.ethernet, NO_ADAPTER),
    detectionRow('Bluetooth', network.bluetooth, NO_ADAPTER),
    ...['USB ports', 'SD card reader', 'Microphone', 'Mouse'].map(
      (component): TestRow => ({
        component,
        statusLabel: 'Not tested',
        tone: 'neutral',
        details: NO_TEST,
        testedOn: DASH,
      }),
    ),
  ];
}

function HardwareTestResults({ profile }: { profile: Obj }) {
  const hwt = subObject(profile, 'hardwareTest');
  const view = hardwareTestView(profile.hardwareTest);

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-neutral-800 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-white">
          Hardware test results
        </h3>
        {view.present && <Badge label={view.overall.label} tone={view.overall.tone} />}
      </div>

      {!view.present ? (
        <p className="px-3 py-3 text-sm text-neutral-700">
          No hardware test on record for this device.
        </p>
      ) : (
        <>
          {view.meta && <p className="px-3 pt-2 text-xs text-neutral-600">{view.meta}</p>}
          <div className="overflow-x-auto">
            <table className="mt-2 w-full border-collapse text-left text-sm">
              <caption className="sr-only">
                Per-component results of the technician hardware test, plus the components this
                audit detects but does not functionally test.
              </caption>
              <thead className="text-[11px] uppercase tracking-wide text-neutral-600">
                <tr className="border-y border-neutral-200 bg-neutral-50">
                  <th scope="col" className="px-3 py-1.5 font-medium">Component</th>
                  <th scope="col" className="px-3 py-1.5 font-medium">Status</th>
                  <th scope="col" className="px-3 py-1.5 font-medium">Details / notes</th>
                  <th scope="col" className="px-3 py-1.5 font-medium">Tested on</th>
                </tr>
              </thead>
              <tbody>
                {[...testedRows(view, hwt), ...untestedRows(profile)].map((r) => (
                  <tr key={r.component} className="border-b border-neutral-100 align-top last:border-0">
                    <th scope="row" className="px-3 py-1.5 font-medium text-neutral-950">
                      {r.component}
                    </th>
                    <td className="px-3 py-1.5">
                      <Badge label={r.statusLabel} tone={r.tone} />
                    </td>
                    <td className="px-3 py-1.5 text-neutral-700">{r.details}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-neutral-700">{r.testedOn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.earlierCount > 0 && (
            <p className="px-3 py-2 text-xs text-neutral-500">
              {view.earlierCount} earlier result{view.earlierCount === 1 ? '' : 's'} on record
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------- the generic walker (fallback) */

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
  lockStatus: 'Lock status',
};

function humanize(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(v: unknown): string {
  if (v == null || v === '') return DASH;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Every profile key each card above has already shown, so the fallback lists
// what is genuinely left over rather than repeating the whole profile.
const CARD_KEYS: Record<string, string[]> = {
  identification: [
    'manufacturer', 'model', 'productName', 'productFamily', 'deviceType',
    'serialNumber', 'serviceTag', 'expressServiceCode', 'biosUuid', 'assetTag',
  ],
  system: ['biosVersion', 'biosReleaseDate', 'bootMode', 'secureBoot', 'tpmVersion', 'os', 'osVersion', 'osBuild'],
  cpu: ['manufacturer', 'model', 'generation', 'cores', 'threads', 'baseClock', 'maxClock'],
  memory: ['type', 'totalGb', 'speed', 'modules', 'slots', 'maxGb', 'detectedGb'],
  display: ['size', 'resolution', 'refreshRate', 'touchscreen'],
  battery: ['health', 'designCapacity', 'fullChargeCapacity', 'cycleCount', 'status'],
  network: ['wifi', 'ethernet', 'bluetooth', 'macAddress'],
  security: ['tpm', 'secureBoot', 'bitlocker', 'biosPassword'],
};

// Per-drive keys the Storage card already shows, plus two that must never be
// printed raw: `health` is the C5 object the Health status row words, and
// `healthPct` is the pre-C5 engine's single-attribute wear figure — computed a
// different way, so beside the real percentage it would read as a second,
// contradicting health score.
const DRIVE_CARD_KEYS = [
  'model', 'type', 'capacity', 'interface', 'serialNumber', 'smartStatus',
  'health', 'healthPct', 'powerOnHours', 'powerCycles', 'temperatureC', 'ssdLifeUsedPct',
];

const GPU_CARD_KEYS = ['manufacturer', 'model', 'type', 'vram'];

// Rendered by their own sections elsewhere on the page, or by the test table
// above: `locks` is the Device locks section, `driveHealth` is the old kiosk's
// unprivileged SMART probe (superseded by each drive's own health), and
// `hardwareTest` would print audio-mixer commands and colour swatches verbatim.
const HANDLED_ELSEWHERE = new Set(['locks', 'driveHealth', 'hardwareTest']);

const CATEGORY_LABELS: Record<string, string> = {
  identification: 'Hardware information',
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

function leftoverRows(obj: Obj, shown: string[]): Row[] {
  return Object.entries(obj)
    .filter(([k, v]) => !shown.includes(k) && v != null && v !== '')
    .map(([k, v]) => ({ label: humanize(k), value: formatValue(v) }));
}

// Anything in the profile that no card above claimed: a leftover key inside a
// category we do render, a whole category we do not (hiddenStorage today), or a
// key the capture tool starts sending tomorrow. The point is that nothing can
// silently disappear from this page just because no card was written for it.
function otherCapturedRows(profile: Obj): Row[] {
  const rows: Row[] = [];
  const push = (group: string, source: Row[]) => {
    source.forEach((r) => rows.push({ ...r, label: `${group} — ${r.label}` }));
  };

  for (const [category, shown] of Object.entries(CARD_KEYS)) {
    push(CATEGORY_LABELS[category] ?? humanize(category), leftoverRows(subObject(profile, category), shown));
  }
  subArray(profile, 'storage').forEach((drive, i) => {
    push(`Storage drive ${i + 1}`, leftoverRows(drive, DRIVE_CARD_KEYS));
  });
  subArray(profile, 'graphics').forEach((gpu, i) => {
    push(`GPU ${i + 1}`, leftoverRows(gpu, GPU_CARD_KEYS));
  });

  for (const [key, value] of Object.entries(profile)) {
    // hasOwnProperty, not `in`: a profile key called "constructor" or "toString"
    // would otherwise match Object's prototype and be dropped silently.
    if (Object.prototype.hasOwnProperty.call(CARD_KEYS, key)) continue;
    if (key === 'storage' || key === 'graphics') continue;
    if (HANDLED_ELSEWHERE.has(key)) continue;
    const label = CATEGORY_LABELS[key] ?? humanize(key);
    if (Array.isArray(value)) {
      value.forEach((el, i) => {
        if (isObj(el)) push(`${label} ${i + 1}`, leftoverRows(el, []));
        else rows.push({ label: `${label} ${i + 1}`, value: formatValue(el) });
      });
    } else if (isObj(value)) {
      push(label, leftoverRows(value, []));
    } else if (value != null && value !== '') {
      rows.push({ label, value: formatValue(value) });
    }
  }
  return rows;
}

/* ------------------------------------------------------------- the section */

export function HardwareSection({
  profile,
  device,
}: {
  profile: Record<string, unknown> | null | undefined;
  device?: HardwareDeviceHeader;
}) {
  if (!profile || Object.keys(profile).length === 0) return null;

  const ident = subObject(profile, 'identification');
  const drives = subArray(profile, 'storage');
  const gpus = subArray(profile, 'graphics');
  const battery = subObject(profile, 'battery');
  // An absent battery object means a desktop, not a missing reading — the card
  // says so instead of showing a column of dashes.
  const hasBattery = isObj(profile.battery) && Object.values(profile.battery as Obj).some(has);
  const other = otherCapturedRows(profile);

  return (
    <section className="md:col-span-2 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">
          Hardware profile
        </h2>
        <span className="text-xs text-neutral-500">Auto-captured · read-only</span>
      </div>
      <p className="mt-1 text-sm text-neutral-600">
        Detailed hardware, system information and test results for this device. A dash ({DASH})
        means the audit did not capture that value — it is not a reading of zero or none.
      </p>

      <DeviceHeader ident={ident} device={device} />

      <div className="mt-4 grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <TableCard title="Hardware information" rows={hardwareInformationRows(ident)} />

        {/* One card per drive, so a two-drive machine shows two health figures
            rather than one averaged into meaninglessness. */}
        {drives.map((drive, i) => (
          <TableCard
            key={`drive-${i}`}
            title={i === 0 ? 'Storage' : `Storage (Drive ${i + 1})`}
            rows={storageRows(drive, driveHealthView(drive))}
          />
        ))}
        {drives.length === 0 && (
          <Card title="Storage">
            <p className="px-3 py-3 text-sm text-neutral-700">No drives on record.</p>
          </Card>
        )}

        <TableCard title="BIOS / firmware" rows={biosRows(subObject(profile, 'system'), ident)} />
        <TableCard title="Processor" rows={processorRows(subObject(profile, 'cpu'))} />
        <TableCard title="Display" rows={displayRows(subObject(profile, 'display'))} />
        <TableCard title="Operating system" rows={operatingSystemRows(subObject(profile, 'system'))} />
        <TableCard title="Memory" rows={memoryRows(subObject(profile, 'memory'))} />
        <TableCard title="Graphics" rows={graphicsRows(gpus)} />

        {hasBattery ? (
          <TableCard title="Battery" rows={batteryRows(battery)} />
        ) : (
          <Card title="Battery">
            <p className="px-3 py-3 text-sm text-neutral-700">No battery detected.</p>
          </Card>
        )}

        <TableCard title="Network" rows={networkRows(subObject(profile, 'network'))} />
        <TableCard title="Security" rows={securityRows(subObject(profile, 'security'))} />

        {other.length > 0 && <TableCard title="Other captured details" rows={other} />}
      </div>

      <HardwareTestResults profile={profile} />
    </section>
  );
}
