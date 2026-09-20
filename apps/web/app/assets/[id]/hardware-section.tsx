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
// so a word this page needs is added to BOTH copies (statusBadge) rather than
// re-spelt here; the small date helper below decides no status wording of its
// own.
//
// One contract is never borrowed for another component: the C5 bands grade a
// drive's SMART wear, and nothing here re-uses them to grade a battery.
//
// The generic walker that used to render the whole section is still here, now
// feeding a final "Other captured details" card: a key the capture tool starts
// sending tomorrow must still appear somewhere rather than vanish because no
// card claims it.

import type { ReactNode } from 'react';
import { driveHealthView, type DriveHealthView } from '@/lib/drive-health';
import {
  hardwareTestView,
  statusBadge,
  type HardwareTestView,
  type HwTestTone,
} from '@/lib/hardware-test';
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

// What a card says when it has nothing at all. The default covers a category the
// audit normally fills but did not this time; a card that is ALWAYS empty for a
// known reason says that reason instead.
const NOTHING_CAPTURED = 'Nothing was captured here. Rescan on the station to record it.';

// A card whose rows all come from the mapping above. `caption` describes the
// table for a screen reader, which cannot see the header bar as a heading.
//
// When every row resolved to "—" the card carries one sentence instead of the
// table — the treatment Storage and Battery already had. A column of dashes
// cannot tell an operator whether the scan failed, whether the machine has none
// of this, or whether we simply never look; the sentence can. `emptyMessage` has
// no default on purpose, so writing a card forces an answer to that question.
function TableCard({
  title,
  rows,
  emptyMessage,
}: {
  title: string;
  rows: Row[];
  emptyMessage: string;
}) {
  const empty = rows.every((r) => r.value === DASH && !r.note);
  return (
    <Card title={title}>
      {empty ? (
        <p className="px-3 py-3 text-sm text-neutral-700">{emptyMessage}</p>
      ) : (
        <ParamTable rows={rows} caption={`${title} — captured values for this device`} />
      )}
    </Card>
  );
}

/* ------------------------------------------------------- the device header */

// What the warehouse record knows about the device, as opposed to what the
// machine reported about itself. Status and the capture date cannot come from
// the profile — they are ours, not the hardware's — so the page passes them in.
//
// `capturedAt` is when this profile was last taken (the latest audit), NOT when
// the asset row was last written: a sale or a pallet move touches the row every
// week and would otherwise date a January scan as today, under a heading that
// promises current hardware figures.
export interface HardwareDeviceHeader {
  status?: string | null;
  assetTag?: string | null;
  capturedAt?: string | null;
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
  // A device that has never been audited has no capture date at all, and says so
  // with the section's own dash rather than borrowing another date.
  const captured =
    device?.capturedAt && !Number.isNaN(new Date(device.capturedAt).getTime())
      ? new Date(device.capturedAt).toLocaleDateString('en-GB', {
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
        <HeaderFact label="Profile captured" value={captured} />
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

// A drive the storage controller hides from the capture (Intel RST "RAID On", a
// RAID-class controller). The station files these in profile.hiddenStorage
// instead of storage[] precisely because they can never be read or wiped here,
// so they must still appear as Storage: a machine whose only drives are hidden
// is the one case where "no drives" would be a dangerous thing to print.
// Everything about the drive itself is genuinely unknown — only the controller,
// the kernel's count and the C5 not-measurable verdict were captured.
function hiddenStorageRows(entry: Obj, view: DriveHealthView): Row[] {
  const count = typeof entry.count === 'number' && entry.count > 0 ? entry.count : null;
  return [
    {
      label: 'Drives behind the controller',
      value: count != null ? String(count) : DASH,
      note: 'The controller hides these from the audit, so they cannot be read or wiped here.',
    },
    { label: 'Controller', value: text(entry.controller) },
    {
      label: 'Health status',
      // The same C5 formatter the visible drives use: the entry already carries
      // a measured:false health object, so this reads "Not measurable — behind a
      // RAID/Intel RST controller — set the storage mode to AHCI in the BIOS,
      // then press Rescan". The cell already carries the fix, so it is not
      // repeated underneath.
      value: view.cell,
      tone: view.tone,
    },
    // Named so it is obvious we cannot identify these drives, rather than left
    // out as if we had nothing to say about them.
    { label: 'Drive model', value: DASH },
    { label: 'Capacity', value: DASH },
    { label: 'Serial number', value: DASH },
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
  // An empty graphics array is not evidence of no graphics: the capture drops
  // the key entirely when it enumerated nothing, and a hand-added device never
  // sets it. Every machine here has a display adapter, so "Not detected" would
  // be a claim about a machine nobody looked at — the dash is the honest answer.
  if (gpus.length === 0) rows.push({ label: 'GPU 1', value: DASH });
  // A second GPU is different: the array exists, so enumeration demonstrably ran
  // and found one card. Saying so plainly beats leaving the reader to wonder.
  if (gpus.length === 1) rows.push({ label: 'GPU 2', value: 'Not detected' });
  // Driver versions and shared-memory figures belong to a running Windows
  // install; the audit boots its own OS and never sees them.
  rows.push({ label: 'Driver version', value: DASH });
  rows.push({ label: 'Shared memory', value: DASH });
  return rows;
}

// The stored battery health is full-charge capacity over design capacity as the
// firmware reports it ("87%"), or whatever a technician typed when the device
// was hand-added. It is printed exactly as captured, with no verdict word and no
// tint.
//
// The design asks for a tinted health row here as well as on Storage, but a tint
// needs a word beside it (colour is never the only signal), and a word needs
// bands — and nobody has set bands for a battery. The C5 bands next door are the
// owner's rule for a DRIVE's SMART wear: borrowing them would stamp "Caution" in
// amber on an 85% battery that is perfectly saleable, and would silently re-grade
// every battery in the estate the day the drive bands move. The figure is the
// fact; a grade we were never given is not ours to invent.
function batteryRows(battery: Obj): Row[] {
  return [
    { label: 'Health', value: text(battery.health) },
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

// One audio channel's own outcome, worded by the C6 formatter — null when the
// station recorded nothing for that side.
//
// The kiosk stores each side as the same three words a component uses: PASSED,
// ATTENTION ("quiet or distorted") or FAILED. All three are real outcomes the
// technician chose, so all three are handed to statusBadge and come back in its
// vocabulary. A side must never be squeezed into a pass/fail pair: reading
// ATTENTION as "no outcome" used to make the row inherit the COMBINED verdict,
// so a quiet left speaker printed a red "Failed" the technician never gave it.
function channelOutcome(v: unknown): { label: string; tone: Tone } | null {
  // An older capture worded a side as a plain boolean or an everyday word.
  if (typeof v === 'boolean') return statusBadge(v ? 'PASSED' : 'FAILED');
  if (typeof v !== 'string' || !v.trim()) return null;
  if (/^(passed|attention|failed|in_progress|not_tested)$/i.test(v.trim())) {
    return statusBadge(v);
  }
  if (/pass|work|good|^ok$|^yes$/i.test(v)) return statusBadge('PASSED');
  if (/fail|faulty|bad|dead|^no$/i.test(v)) return statusBadge('FAILED');
  return null;
}

// hardwareTestView returns ONE "Speaker" row, because the station runs one
// speaker test; the owner's design lists the two channels separately. Every word
// still comes from the formatter — the page only decides WHICH status belongs to
// this side, which is the one fact a combined row cannot carry. A side the
// station did not record inherits the component's own verdict, and when the
// speaker test did not finish BOTH sides do: a channel must never show a green
// "Passed" for a test nobody ran.
function speakerRows(view: HardwareTestView, part: Obj): TestRow[] {
  const base = view.rows.find((r) => r.component === 'Speaker');
  const fallbackLabel = base?.statusLabel ?? 'Not tested';
  const fallbackTone: Tone = base?.tone ?? 'neutral';
  const finished = fallbackTone === 'good' || fallbackTone === 'warn' || fallbackTone === 'bad';
  const testedOn = testDate(part.testedAt);

  return (['left', 'right'] as const).map((side) => {
    const own = finished ? channelOutcome(part[side]) : null;
    return {
      component: side === 'left' ? 'Left speaker' : 'Right speaker',
      statusLabel: own?.label ?? fallbackLabel,
      tone: own?.tone ?? fallbackTone,
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

// Rendered by their own sections elsewhere on the page, by the test table above,
// or by a card of their own: `locks` is the Device locks section, `driveHealth`
// is the old kiosk's unprivileged SMART probe (superseded by each drive's own
// health), `hardwareTest` would print audio-mixer commands and colour swatches
// verbatim, and `hiddenStorage` now has its own Storage card — printed raw here
// as well, its C5 health object would arrive as a line of JSON.
const HANDLED_ELSEWHERE = new Set(['locks', 'driveHealth', 'hardwareTest', 'hiddenStorage']);

// Per-entry keys the hidden-storage card already shows.
const HIDDEN_CARD_KEYS = ['controller', 'count', 'health'];

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
// category we do render, a whole category we do not, or a key the capture tool
// starts sending tomorrow. The point is that nothing can silently disappear from
// this page just because no card was written for it.
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
  subArray(profile, 'hiddenStorage').forEach((entry, i) => {
    push(`Hidden storage ${i + 1}`, leftoverRows(entry, HIDDEN_CARD_KEYS));
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
  // Drives the controller hid from the capture. They are real drives — they just
  // could not be read — so they get Storage cards of their own, and a machine
  // that has them is never described as having no drives.
  const hidden = subArray(profile, 'hiddenStorage');
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
        <TableCard
          title="Hardware information"
          rows={hardwareInformationRows(ident)}
          emptyMessage={NOTHING_CAPTURED}
        />

        {/* One card per drive, so a two-drive machine shows two health figures
            rather than one averaged into meaninglessness. */}
        {drives.map((drive, i) => (
          <TableCard
            key={`drive-${i}`}
            title={i === 0 ? 'Storage' : `Storage (Drive ${i + 1})`}
            rows={storageRows(drive, driveHealthView(drive))}
            emptyMessage={NOTHING_CAPTURED}
          />
        ))}
        {hidden.map((entry, i) => (
          <TableCard
            key={`hidden-${i}`}
            title={
              hidden.length === 1
                ? 'Storage (hidden by the controller)'
                : `Storage (hidden by controller ${i + 1})`
            }
            rows={hiddenStorageRows(entry, driveHealthView(entry))}
            emptyMessage={NOTHING_CAPTURED}
          />
        ))}
        {/* Only when the capture filed nothing either way. An empty storage[] is
            dropped from the profile whether the audit enumerated no drives or
            never ran at all — a hand-added device has no drives recorded and
            nobody scanned it — so this says the drives were not captured rather
            than asserting the machine has none. */}
        {drives.length === 0 && hidden.length === 0 && (
          <Card title="Storage">
            <p className="px-3 py-3 text-sm text-neutral-700">
              No drive was captured for this device. That is not the same as having none — rescan
              on the station to record its drives.
            </p>
          </Card>
        )}

        <TableCard
          title="BIOS / firmware"
          rows={biosRows(subObject(profile, 'system'), ident)}
          emptyMessage={NOTHING_CAPTURED}
        />
        <TableCard
          title="Processor"
          rows={processorRows(subObject(profile, 'cpu'))}
          emptyMessage={NOTHING_CAPTURED}
        />
        <TableCard
          title="Display"
          rows={displayRows(subObject(profile, 'display'))}
          emptyMessage="No display was captured. A desktop has no built-in screen, and an unreadable panel records nothing."
        />
        {/* Today this card is always the message: the audit boots the machine
            from our own live stick, so system.os / osVersion / osBuild are never
            written. It stays wired to those fields so that the day a capture does
            read the installed OS, the table fills itself in. */}
        <TableCard
          title="Operating system"
          rows={operatingSystemRows(subObject(profile, 'system'))}
          emptyMessage="The audit boots this machine from our own live stick, so it never reads the installed operating system."
        />
        <TableCard
          title="Memory"
          rows={memoryRows(subObject(profile, 'memory'))}
          emptyMessage={NOTHING_CAPTURED}
        />
        <TableCard
          title="Graphics"
          rows={graphicsRows(gpus)}
          emptyMessage={NOTHING_CAPTURED}
        />

        {hasBattery ? (
          <TableCard title="Battery" rows={batteryRows(battery)} emptyMessage={NOTHING_CAPTURED} />
        ) : (
          <Card title="Battery">
            <p className="px-3 py-3 text-sm text-neutral-700">No battery detected.</p>
          </Card>
        )}

        <TableCard
          title="Network"
          rows={networkRows(subObject(profile, 'network'))}
          emptyMessage={NOTHING_CAPTURED}
        />
        <TableCard
          title="Security"
          rows={securityRows(subObject(profile, 'security'))}
          emptyMessage={NOTHING_CAPTURED}
        />

        {other.length > 0 && (
          <TableCard title="Other captured details" rows={other} emptyMessage={NOTHING_CAPTURED} />
        )}
      </div>

      <HardwareTestResults profile={profile} />
    </section>
  );
}
