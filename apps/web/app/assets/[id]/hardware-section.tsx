// The asset page's Hardware Profile section (assets.hardware_profile JSONB),
// laid out the way the owner designed it the second time: a title block, a
// device bar, and then ONE table — Category | Parameter | Value | Status |
// Details / notes | Tested on — whose Category cell spans its whole group. The
// three-column card grid this replaces split the same facts across a dozen
// boxes, so a reader comparing "is the drive healthy?" with "did the keyboard
// pass?" had to hunt. One table reads top to bottom.
//
// The rule the whole file obeys: never claim what was not measured. Every row is
// fed by ONE named profile field. Anything the capture tool does not record
// renders the design's em-dash "—" — never a guess, never a filled-in blank, and
// never the word "Unknown" (a stored literal "unknown" is treated as no answer
// at all). Colour is never the only signal: every status pill prints its word,
// so a greyscale print of this page reads identically (WCAG 1.4.1).
//
// Two pieces of wording are deliberately NOT decided here. Each drive's health
// (contract C5) is worded by lib/drive-health.ts, and the technician Hardware
// Test (contract C6) by lib/hardware-test.ts — the same formatters the xlsx
// reports use, so one device cannot read "Passed" on this page and "Failed" in
// an export. Both files are byte-locked to their apps/api twins by a jest spec,
// so a word this page needs is taken from them (statusBadge, STATUS_LABEL)
// rather than re-spelt here; the small date helper below decides no status
// wording of its own.
//
// The test group is built from whatever hardwareTestView REPORTS, not from a
// hard-coded list: the station grew from five tests to seven (microphone and USB
// ports joined on the bench), and a list written out here would have quietly
// dropped them. Components the design draws but nobody tests — Mouse, SD card
// reader, Docking support — are shown, and shown as "Not tested".
//
// One contract is never borrowed for another component: the C5 bands grade a
// drive's SMART wear, and nothing here re-uses them to grade a battery.
//
// The generic walker that used to render the whole section is still here, now
// feeding a final "Other captured details" group: a key the capture tool starts
// sending tomorrow must still appear somewhere rather than vanish because no
// group claims it.

import type { ReactNode } from 'react';
import { driveHealthView, STATUS_LABEL, type DriveHealthView } from '@/lib/drive-health';
import {
  hardwareTestView,
  statusBadge,
  type HardwareTestRow,
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

// The first of several candidate keys that actually holds something. The capture
// tool has spelt the same fact differently over time (and SMBIOS itself offers
// both "SKU Number" and a part number), so a row names every spelling it accepts
// instead of picking one and going blank on the others.
function firstOf(obj: Obj, keys: string[]): string {
  for (const k of keys) {
    if (has(obj[k])) return text(obj[k]);
  }
  return DASH;
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

// A captured date rendered the same way, but falling back to the stored string
// when it is not a date we can parse. The registry's install date is an ISO
// date; a hand-typed one may be anything, and mangling it into DASH would throw
// away a real answer.
function dateText(v: unknown): string {
  const formatted = testDate(v);
  return formatted === DASH ? text(v) : formatted;
}

/* ------------------------------------------------------------------ layout */

// The status pill's colours. Only ever a hint: the pill always prints its word,
// so the meaning survives greyscale and colour blindness. "Detected" and "Not
// tested" are deliberately the same neutral outline as each other and visibly
// NOT the green of a real Pass.
const BADGE_TONE: Record<Tone, string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  bad: 'border-red-200 bg-red-50 text-red-900',
  neutral: 'border-neutral-300 bg-white text-neutral-700',
};

// The value cell's soft highlight, used only where a value carries a verdict of
// its own (a drive's health). The word is in the cell too, always.
const VALUE_TONE: Record<Tone, string> = {
  good: 'bg-emerald-50 text-emerald-900',
  warn: 'bg-amber-50 text-amber-900',
  bad: 'bg-red-50 text-red-900',
  neutral: '',
};

interface Status {
  label: string;
  tone: Tone;
}

function Badge({ label, tone }: Status) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${BADGE_TONE[tone]}`}
    >
      {label}
    </span>
  );
}

// "Not tested" is the C6 formatter's own word for a component with no result, so
// it is fetched from the formatter rather than typed out here — the day that
// wording changes, this page changes with it.
const NOT_TESTED: Status = statusBadge(null);

// "Detected" is this page's word, not the formatter's: the formatter only ever
// describes tests, and these rows are not tests. Neutral on purpose — a part
// that is present has not been shown to work.
const DETECTED: Status = { label: 'Detected', tone: 'neutral' };

// One row of the unified table. `value` is the spec figure, `status` the pill —
// a pure spec row has no status, no details and no date, and the table prints
// the design's dash in all three.
interface TableRow {
  parameter: string;
  value: ReactNode;
  valueTone?: Tone;
  status?: Status;
  details?: ReactNode;
  testedOn?: string;
}

type IconName =
  | 'device'
  | 'firmware'
  | 'os'
  | 'cpu'
  | 'memory'
  | 'storage'
  | 'graphics'
  | 'display'
  | 'battery'
  | 'network'
  | 'test'
  | 'info'
  | 'history'
  | 'other';

interface Group {
  key: string;
  title: string;
  icon: IconName;
  rows: TableRow[];
}

// Hand-drawn 24×24 strokes rather than an icon package: this repo adds no
// dependency for decoration. They are aria-hidden — the category name is beside
// every one of them, so nothing is carried by the picture alone.
const ICON_PATHS: Record<IconName, string[]> = {
  device: ['M3 5h18v11H3z', 'M1.5 19.5h21'],
  firmware: ['M12 3l7 3v6c0 4-3 7.5-7 9-4-1.5-7-5-7-9V6z', 'M9.5 12l2 2 3.5-3.5'],
  os: ['M3 5h18v14H3z', 'M3 9h18'],
  cpu: ['M6 6h12v12H6z', 'M10 10h4v4h-4z', 'M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3'],
  memory: ['M2 8h20v8H2z', 'M6 16v3.5M10 16v3.5M14 16v3.5M18 16v3.5', 'M6 11h2M11 11h2M16 11h2'],
  storage: ['M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6'],
  graphics: ['M3 6h18v9H3z', 'M9 10.5a3 3 0 106 0 3 3 0 10-6 0', 'M7 15v4M17 15v4'],
  display: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
  battery: ['M2 8h17v8H2z', 'M21 11v2', 'M5 11h6'],
  network: ['M5 10a10 10 0 0114 0', 'M8 13.5a6 6 0 018 0', 'M12 17h.01'],
  test: ['M9 4h6v3H9z', 'M7 5.5H5v14.5h14V5.5h-2', 'M9.5 13l2 2 4-4'],
  info: ['M12 3a9 9 0 100 18 9 9 0 100-18', 'M12 11v5.5', 'M12 7.5h.01'],
  history: ['M3.5 12a8.5 8.5 0 108.5-8.5A8.5 8.5 0 005 7.5', 'M5 3.5v4h4', 'M12 8v4.5l3 1.5'],
  other: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

// A spec row: a captured figure and nothing else. The three trailing columns are
// the design's dashes, which is the honest answer — nobody tested a serial
// number.
function spec(parameter: string, value: ReactNode): TableRow {
  return { parameter, value };
}

// The whole profile as one table. Each category is its own <tbody> so the
// alternating band and the spanning Category cell follow the group rather than
// the row count, and a screen reader hears one row group per category.
//
// The table keeps a minimum width and scrolls inside its own box on a phone:
// a rowspan layout cannot reflow into a single column without losing the
// grouping, and squashing six columns into 360px makes every cell unreadable.
function ProfileTable({ groups }: { groups: Group[] }) {
  return (
    // The box scrolls sideways on a phone, so it has to be reachable by
    // keyboard: nothing inside this table is focusable (no link, no button, and
    // the icons are aria-hidden), and a browser will not hand a scroll container
    // the focus ring on its own. Without tabIndex a keyboard or switch user
    // could never reach the Status, Details and Tested on columns — the pass and
    // fail verdicts this page exists to show (WCAG 2.1.1). role + a name stop it
    // announcing as an unlabelled scroller; the name is the caption, so the
    // wording is written once. The section renders once per asset page, so a
    // fixed id cannot collide.
    <div
      tabIndex={0}
      role="region"
      aria-labelledby="hardware-profile-table-caption"
      className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-700"
    >
      <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
        <caption id="hardware-profile-table-caption" className="sr-only">
          The device&apos;s captured hardware profile and technician test results, grouped by
          category. A dash means the value was not captured.
        </caption>
        <thead className="text-[11px] uppercase tracking-wide text-neutral-700">
          <tr className="border-b border-neutral-300 bg-neutral-100">
            <th scope="col" className="px-3 py-2 font-semibold">Category</th>
            <th scope="col" className="px-3 py-2 font-semibold">Parameter</th>
            <th scope="col" className="px-3 py-2 font-semibold">Value</th>
            <th scope="col" className="px-3 py-2 font-semibold">Status</th>
            <th scope="col" className="px-3 py-2 font-semibold">Details / notes</th>
            <th scope="col" className="px-3 py-2 font-semibold">Tested on</th>
          </tr>
        </thead>
        {groups.map((group, gi) => (
          <tbody key={group.key} className={gi % 2 === 1 ? 'bg-neutral-50' : 'bg-white'}>
            {group.rows.map((row, ri) => (
              <tr
                key={`${group.key}-${ri}-${row.parameter}`}
                className="border-b border-neutral-200 align-top last:border-b-0"
              >
                {ri === 0 && (
                  <th
                    scope="rowgroup"
                    rowSpan={group.rows.length}
                    className={`w-44 border-r border-neutral-200 px-3 py-2 text-left align-top text-xs font-semibold text-neutral-900 ${
                      gi % 2 === 1 ? 'bg-neutral-100' : 'bg-neutral-50'
                    }`}
                  >
                    <span className="flex items-start gap-2">
                      <Icon name={group.icon} />
                      <span>{group.title}</span>
                    </span>
                  </th>
                )}
                <th scope="row" className="w-48 px-3 py-2 text-left font-normal text-neutral-600">
                  {row.parameter}
                </th>
                <td
                  className={`px-3 py-2 break-words ${
                    row.value === DASH ? 'text-neutral-400' : 'text-neutral-950'
                  } ${row.valueTone ? `font-semibold ${VALUE_TONE[row.valueTone]}` : ''}`}
                >
                  {row.value}
                </td>
                <td className="px-3 py-2">
                  {row.status ? <Badge label={row.status.label} tone={row.status.tone} /> : (
                    <span className="text-neutral-400">{DASH}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-neutral-700">
                  {row.details ?? <span className="text-neutral-400">{DASH}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-700">
                  {row.testedOn && row.testedOn !== DASH ? (
                    row.testedOn
                  ) : (
                    <span className="text-neutral-400">{DASH}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/* --------------------------------------------------------- the device bar */

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
      <dd
        className="truncate text-sm font-medium text-white"
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

function DeviceBar({ ident, device }: { ident: Obj; device?: HardwareDeviceHeader }) {
  const maker = text(ident.manufacturer);
  const model = text(ident.model);
  const name = [maker, model].filter((p) => p !== DASH).join(' ') || DASH;
  const status = device?.status ? device.status.trim() : '';
  // The SMBIOS asset tag if the machine carries one, otherwise our own printed
  // tag — both are real recorded values, neither is a guess.
  const tag = has(ident.assetTag) ? text(ident.assetTag) : text(device?.assetTag);
  // "Last updated" means this PROFILE's last capture, which is the latest audit
  // date the page hands us — never the asset row's mtime, which a sale moves.
  const updated =
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
        <HeaderFact label="Serial number" value={text(ident.serialNumber)} />
        <HeaderFact label="Asset tag" value={tag} />
        <HeaderFact label="Device type" value={text(ident.deviceType)} />
        <HeaderFact
          label="Status"
          value={status ? <Badge label={formatLabel(status)} tone={statusTone(status)} /> : DASH}
        />
        <HeaderFact label="Last updated" value={updated} />
      </dl>
    </div>
  );
}

/* -------------------------------------------------------- the spec groups */

function deviceInformationRows(ident: Obj): TableRow[] {
  return [
    spec('Manufacturer', text(ident.manufacturer)),
    spec('Model', text(ident.model)),
    spec('Product name', text(ident.productName)),
    spec('SKU / model number', firstOf(ident, ['skuNumber', 'sku', 'partNumber'])),
    spec('Serial number', text(ident.serialNumber)),
    // The tag the MACHINE reports. Our own printed tag is in the device bar
    // above; merging the two here would hide which of them the device carries.
    spec('Asset tag', text(ident.assetTag)),
    spec('Chassis type', text(ident.deviceType)),
    spec('System family', text(ident.productFamily)),
    // Nothing in the capture reads a manufacture date. The design asks for the
    // row, so it stays — empty and honest.
    spec('Manufacture date', DASH),
    spec('UUID', text(ident.biosUuid)),
  ];
}

// BIOS / firmware. `security.tpm` and `security.secureBoot` are the same two
// facts the lock checks record, so whichever of the two sources answered is
// shown once here rather than as a second, apparently independent reading.
function biosRows(system: Obj, security: Obj): TableRow[] {
  return [
    // dmidecode's BIOS vendor, when the capture records one. The SYSTEM
    // manufacturer is not it: a Dell laptop can ship a Phoenix BIOS, and
    // printing "Dell" under this label would be an answer we never read.
    spec('BIOS manufacturer', firstOf(system, ['biosVendor', 'biosManufacturer'])),
    spec('BIOS version', text(system.biosVersion)),
    spec('BIOS release date', dateText(system.biosReleaseDate)),
    spec('UEFI / boot mode', text(system.bootMode)),
    spec('TPM version', has(system.tpmVersion) ? text(system.tpmVersion) : text(security.tpm)),
    spec('Secure Boot', has(system.secureBoot) ? text(system.secureBoot) : text(security.secureBoot)),
    // Neither the embedded controller nor the Management Engine firmware
    // revision is read by the capture tool.
    spec('Embedded controller', DASH),
    spec('ME firmware', DASH),
  ];
}

// The feature update and the build are two halves of one answer, so they are
// printed as one: "23H2 (22631.2861)". Either half alone still prints — a build
// with no feature update is a real reading, not a broken one.
function osVersionText(system: Obj): string {
  const version = text(system.osVersion);
  const build = text(system.osBuild);
  if (version !== DASH && build !== DASH) return `${version} (${build})`;
  return version !== DASH ? version : build;
}

// The installed OS, which the station reads offline out of the machine's own
// registry hives (it mounts the Windows volume read-only — the same mount the
// lock checks already make — and reads them with hivex).
//
// `os` carries one of two quite different things and the row must not dress
// either one up. Usually it is a product name, "Windows 11 Pro". When there was
// nothing to name, it is a plain sentence the station wrote instead: "No
// operating system installed" for a wiped machine, "Windows present but
// encrypted (BitLocker) — cannot be read without the recovery key", or what
// stopped the read. Both go through text() unchanged, so a sentence prints as a
// sentence — and neither is ever the word "Unknown".
function operatingSystemRows(system: Obj): TableRow[] {
  return [
    spec('OS name', text(system.os)),
    spec('Version', osVersionText(system)),
    spec('Architecture', text(system.osArchitecture)),
    spec('Installation date', dateText(system.osInstalledOn)),
    spec('Product ID', text(system.osProductId)),
  ];
}

function processorRows(cpu: Obj): TableRow[] {
  const cores = typeof cpu.cores === 'number' ? `${cpu.cores} Cores` : '';
  const threads = typeof cpu.threads === 'number' ? `${cpu.threads} Threads` : '';
  const both = [cores, threads].filter(Boolean).join(' / ');
  return [
    spec('CPU', text(cpu.model)),
    spec('Cores / threads', both || DASH),
    spec('Base speed', text(cpu.baseClock)),
    spec('Max speed', text(cpu.maxClock)),
    // Whether VT-x/AMD-V is enabled in firmware is not read by the capture.
    spec('Virtualization', DASH),
  ];
}

// "Slots used" is an occupancy claim, and the capture counts its two halves
// separately: the slots on the board, and the slots whose Size line parses as a
// fitted module. Either can come back empty, so a board with four slots and no
// readable module sizes really does arrive as { slots: 4 }. Printing that as
// "4 slots" under this heading would tell a reader pricing the upgrade headroom
// that all four are full — the most optimistic reading of a figure nobody
// measured. The slot count is still worth knowing, so it moves out of the claim
// and into the note beside the dash.
function slotsUsedRow(modules: number | null, slots: number | null): TableRow {
  if (modules != null && slots != null) return spec('Slots used', `${modules} of ${slots}`);
  if (modules != null) return spec('Slots used', String(modules));
  return {
    parameter: 'Slots used',
    value: DASH,
    details:
      slots != null
        ? `${slots} memory slots on the board — the capture did not record how many hold a module.`
        : undefined,
  };
}

function memoryRows(memory: Obj): TableRow[] {
  const modules = typeof memory.modules === 'number' ? memory.modules : null;
  const slots = typeof memory.slots === 'number' ? memory.slots : null;

  return [
    spec('Type', text(memory.type)),
    spec('Total size', withUnit(memory.totalGb, 'GB')),
    spec('Speed', text(memory.speed)),
    slotsUsedRow(modules, slots),
    // SMBIOS type 17 carries a form factor, but the capture does not read it.
    spec('Form factor', DASH),
  ];
}

// The health engine writes each figure twice: inside the C5 `health` object and
// as a flat key on the drive, kept for readers that predate C5. Same engine,
// same reading — printing both would read as two measurements that happen to
// agree, so the row takes the C5 value and falls back to the flat twin.
function driveNumber(drive: Obj, health: Obj, key: string, flatKey: string): unknown {
  return health[key] ?? drive[flatKey];
}

// Everything the C5 formatter worked out, under the health row. Nothing is
// repeated from the cell itself: a not-measurable drive already carries its
// reason AND its fix in the cell, so it gets no details line at all.
function driveDetails(view: DriveHealthView): ReactNode | undefined {
  const parts: string[] = [];
  if (view.basis) parts.push(`Based on: ${view.basis}`);
  if (view.reasons.length > 0) parts.push(view.reasons.join(' · '));
  if (view.legacySmartFailed) parts.push('An earlier scan reported SMART FAILED.');
  if (parts.length === 0) return undefined;
  return parts.map((p) => (
    <span key={p} className="block">
      {p}
    </span>
  ));
}

function storageRows(drive: Obj, view: DriveHealthView): TableRow[] {
  const health = isObj(drive.health) ? drive.health : {};
  return [
    spec('Drive model', text(drive.model)),
    spec('Drive type', text(drive.type)),
    spec('Capacity', text(drive.capacity)),
    // The capture reads the drive, not its filesystems: it never mounts a
    // partition, so there is no used/free figure and no partition list.
    spec('Used space', DASH),
    spec('Free space', DASH),
    spec('Power on hours', withUnit(driveNumber(drive, health, 'powerOnHours', 'powerOnHours'), 'h')),
    {
      // The percentage, the status word and every deduction behind them come
      // from driveHealthView — the C5 contract's wording, identical to the xlsx
      // reports. The pill takes the band's own label, so the cell and the pill
      // cannot disagree.
      parameter: 'Health status',
      value: view.cell,
      valueTone: view.tone,
      status: view.status ? { label: STATUS_LABEL[view.status], tone: view.tone } : undefined,
      details: driveDetails(view),
    },
    spec('Temperature', withUnit(driveNumber(drive, health, 'temperatureC', 'temperatureC'), '°C')),
    spec('Partitions', DASH),
  ];
}

// A drive the storage controller hides from the capture (Intel RST "RAID On", a
// RAID-class controller). The station files these in profile.hiddenStorage
// instead of storage[] precisely because they can never be read or wiped here,
// so they must still appear as Storage: a machine whose only drives are hidden
// is the one case where "no drives" would be a dangerous thing to print.
// Everything about the drive itself is genuinely unknown — only the controller,
// the kernel's count and the C5 not-measurable verdict were captured.
function hiddenStorageRows(entry: Obj, view: DriveHealthView): TableRow[] {
  const count = typeof entry.count === 'number' && entry.count > 0 ? entry.count : null;
  return [
    {
      parameter: 'Drives behind the controller',
      value: count != null ? String(count) : DASH,
      details: 'The controller hides these from the audit, so they cannot be read or wiped here.',
    },
    spec('Controller', text(entry.controller)),
    {
      parameter: 'Health status',
      value: view.cell,
      valueTone: view.tone,
      status: view.status ? { label: STATUS_LABEL[view.status], tone: view.tone } : undefined,
      details: driveDetails(view),
    },
    // Named so it is obvious we cannot identify these drives, rather than left
    // out as if we had nothing to say about them.
    spec('Drive model', DASH),
    spec('Capacity', DASH),
    spec('Used space', DASH),
    spec('Free space', DASH),
  ];
}

// The Storage groups: one per drive, so a two-drive machine shows two health
// figures rather than one averaged into meaninglessness.
function storageGroups(profile: Obj): Group[] {
  const drives = subArray(profile, 'storage');
  const hidden = subArray(profile, 'hiddenStorage');
  const groups: Group[] = [];

  drives.forEach((drive, i) => {
    groups.push({
      key: `storage-${i}`,
      title: drives.length === 1 ? 'Storage' : `Storage — drive ${i + 1}`,
      icon: 'storage',
      rows: storageRows(drive, driveHealthView(drive)),
    });
  });
  hidden.forEach((entry, i) => {
    groups.push({
      key: `hidden-storage-${i}`,
      title:
        hidden.length === 1
          ? 'Storage — hidden by the controller'
          : `Storage — hidden by controller ${i + 1}`,
      icon: 'storage',
      rows: hiddenStorageRows(entry, driveHealthView(entry)),
    });
  });

  // Only when the capture filed nothing either way. An empty storage[] is
  // dropped from the profile whether the audit enumerated no drives or never ran
  // at all — a hand-added device has no drives recorded and nobody scanned it —
  // so this says the drives were not captured rather than asserting the machine
  // has none.
  if (groups.length === 0) {
    groups.push({
      key: 'storage-none',
      title: 'Storage',
      icon: 'storage',
      rows: [
        {
          parameter: 'Drives',
          value: DASH,
          details:
            'No drive was captured for this device. That is not the same as having none — rescan on the station to record its drives.',
        },
      ],
    });
  }
  return groups;
}

function graphicsRows(gpus: Obj[]): TableRow[] {
  const rows: TableRow[] = [];
  gpus.forEach((g, i) => rows.push(spec(`GPU ${i + 1}`, text(g.model))));
  // An empty graphics array is not evidence of no graphics: the capture drops
  // the key entirely when it enumerated nothing, and a hand-added device never
  // sets it. Every machine here has a display adapter, so "Not detected" would
  // be a claim about a machine nobody looked at — the dash is the honest answer.
  if (gpus.length === 0) rows.push(spec('GPU 1', DASH));
  // A second GPU is different: the array exists, so enumeration demonstrably ran
  // and found one card. Saying so plainly beats leaving the reader to wonder.
  if (gpus.length === 1) rows.push(spec('GPU 2', 'Not detected'));

  if (gpus.length > 1) {
    gpus.forEach((g, i) => rows.push(spec(`GPU ${i + 1} dedicated memory`, text(g.vram))));
  } else {
    rows.push(spec('Dedicated memory', gpus.length === 1 ? text(gpus[0].vram) : DASH));
  }
  // Driver versions and shared-memory figures belong to a running Windows
  // install; the audit boots its own OS and never sees them.
  rows.push(spec('Shared memory', DASH));
  rows.push(spec('Driver version', DASH));
  return rows;
}

// The stored battery health is full-charge capacity over design capacity as the
// firmware reports it ("87%"), or whatever a technician typed when the device
// was hand-added. It is printed exactly as captured, with no verdict word and no
// tint.
//
// A tint here would need a word beside it (colour is never the only signal), and
// a word needs bands — and nobody has set bands for a battery. The C5 bands next
// door are the owner's rule for a DRIVE's SMART wear: borrowing them would stamp
// "Caution" in amber on an 85% battery that is perfectly saleable, and would
// silently re-grade every battery in the estate the day the drive bands move.
// The figure is the fact; a grade we were never given is not ours to invent.
function batteryRows(battery: Obj, present: boolean): TableRow[] {
  if (!present) {
    return [
      {
        parameter: 'Battery',
        value: DASH,
        details:
          'No battery was recorded for this device. A desktop has none, and a profile captured before the battery read has none either.',
      },
    ];
  }
  return [
    spec('Design capacity', text(battery.designCapacity)),
    spec('Full charge capacity', text(battery.fullChargeCapacity)),
    spec('Health', text(battery.health)),
    spec('Cycle count', text(battery.cycleCount)),
    spec('Status', text(battery.status)),
  ];
}

const NO_ADAPTER = 'No adapter recorded by the capture tool.';

// A component the capture DETECTS but nobody tests. "Detected" means the part is
// there, not that it works, so the pill is neutral and never green — the details
// line says so in as many words.
function detectionRow(parameter: string, adapter: unknown): TableRow {
  const name = text(adapter);
  if (name === DASH) {
    return { parameter, value: DASH, status: NOT_TESTED, details: NO_ADAPTER };
  }
  return {
    parameter,
    value: name,
    status: DETECTED,
    details: 'Present in the machine — not functionally tested.',
  };
}

function networkRows(network: Obj): TableRow[] {
  const rows: TableRow[] = [
    detectionRow('Wi-Fi', network.wifi),
    detectionRow('Ethernet', network.ethernet),
    detectionRow('Bluetooth', network.bluetooth),
    spec('MAC address (Wi-Fi)', firstOf(network, ['macAddressWifi', 'wifiMac'])),
    spec('MAC address (Ethernet)', firstOf(network, ['macAddressEthernet', 'ethernetMac'])),
  ];
  // The capture usually files ONE MAC address without saying which adapter it
  // belongs to. Guessing it into the Wi-Fi or the Ethernet row would be a claim;
  // dropping it would lose a real value. So it gets its own row, labelled for
  // exactly what it is.
  if (has(network.macAddress)) {
    rows.push({
      parameter: 'MAC address (as captured)',
      value: text(network.macAddress),
      details: 'The capture does not record which adapter this address belongs to.',
    });
  }
  return rows;
}

/* --------------------------------------------- the hardware test results */

// The design's order for the test group. Anything the formatter reports that is
// NOT in this list is appended rather than dropped — the station grew from five
// tests to seven without this file being touched, and it must survive the next
// one the same way.
const DESIGN_TEST_ORDER = [
  'Keyboard',
  'Mouse',
  'Trackpad',
  'Left speaker',
  'Right speaker',
  'Microphone',
  'Camera',
  'USB ports',
  'SD card reader',
  'Docking support',
];

// Components the design draws but the station has no test for. They are shown —
// an operator asking "was the SD slot checked?" deserves an answer — and the
// answer is "Not tested", never a green Pass.
const NO_TEST = 'There is no technician test for this component.';

// The formatter's component label -> the key its raw record lives under, so a
// row can find its own testedAt. A component the formatter adds later falls back
// to its first word, which is how every key so far is spelt.
const COMPONENT_KEY: Record<string, string> = {
  Speaker: 'speaker',
  Keyboard: 'keyboard',
  Camera: 'camera',
  Screen: 'screen',
  Trackpad: 'trackpad',
  Microphone: 'microphone',
  'USB ports': 'usb',
};

function componentKey(component: string): string {
  return COMPONENT_KEY[component] ?? component.toLowerCase().split(' ')[0];
}

// When a component was tested. Its own stamp if the station wrote one, otherwise
// the run's stamp — but only for a component that actually has a result: a row
// reading "Not tested" must never carry a date, or it reads as a test that
// happened.
function whenTested(row: HardwareTestRow, part: Obj, runDate: string): string {
  const own = testDate(part.testedAt);
  if (own !== DASH) return own;
  return row.statusLabel === NOT_TESTED.label ? DASH : runDate;
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
function channelOutcome(v: unknown): Status | null {
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
function speakerRows(base: HardwareTestRow, part: Obj, runDate: string): TableRow[] {
  const finished = base.tone === 'good' || base.tone === 'warn' || base.tone === 'bad';
  const testedOn = whenTested(base, part, runDate);
  return (['left', 'right'] as const).map((side) => {
    const own = finished ? channelOutcome(part[side]) : null;
    return {
      parameter: side === 'left' ? 'Left speaker' : 'Right speaker',
      // A test row's answer IS its status; the Value column belongs to the spec
      // figures, so it stays the design's dash here.
      value: DASH,
      status: own ?? { label: base.statusLabel, tone: base.tone },
      details: base.summary || undefined,
      testedOn,
    };
  });
}

function testRowFrom(row: HardwareTestRow, hwt: Obj, runDate: string): TableRow {
  const part = subObject(hwt, componentKey(row.component));
  return {
    parameter: row.component,
    value: DASH,
    status: { label: row.statusLabel, tone: row.tone },
    details: row.summary || undefined,
    testedOn: whenTested(row, part, runDate),
  };
}

// The test group, built from whatever the C6 formatter reports — not from a list
// written out here, which would go stale the next time the station learns a
// test. Screen is the one component that leaves this group: the owner attaches
// it to Display -> Size, where a reader looking at the panel finds it.
function hardwareTestRows(view: HardwareTestView, hwt: Obj, runDate: string): TableRow[] {
  const reported = new Map<string, TableRow>();
  for (const row of view.rows) {
    if (row.component === 'Screen') continue;
    if (row.component === 'Speaker') {
      for (const r of speakerRows(row, subObject(hwt, 'speaker'), runDate)) {
        reported.set(r.parameter, r);
      }
      continue;
    }
    reported.set(row.component, testRowFrom(row, hwt, runDate));
  }

  const rows: TableRow[] = [];
  for (const parameter of DESIGN_TEST_ORDER) {
    const found = reported.get(parameter);
    if (found) {
      rows.push(found);
      reported.delete(parameter);
    } else {
      // "There is no technician test for this component" is only true when the
      // formatter listed its components and this one was not among them. With no
      // test on record at all it lists nothing, and saying it of the keyboard —
      // which the station does test — would be a lie; the headline above already
      // explains the whole group.
      rows.push({
        parameter,
        value: DASH,
        status: NOT_TESTED,
        details: view.present ? NO_TEST : undefined,
      });
    }
  }
  // Whatever the formatter reports that the design never listed, so a new test
  // appears on this page the day the station starts running it.
  for (const leftover of reported.values()) rows.push(leftover);
  return rows;
}

const NO_TEST_ON_RECORD = 'No hardware test on record for this device.';

// Display, with the screen test attached to Size exactly as the owner drew it.
function displayRows(display: Obj, view: HardwareTestView, hwt: Obj, runDate: string): TableRow[] {
  const screen = view.rows.find((r) => r.component === 'Screen');
  const part = subObject(hwt, 'screen');
  return [
    {
      parameter: 'Size',
      value: text(display.size),
      // With no test on record there is no Screen row to read, and the headline
      // above the table has already said so once — the pill alone is enough here.
      status: screen ? { label: screen.statusLabel, tone: screen.tone } : NOT_TESTED,
      details: screen?.summary || undefined,
      testedOn: screen ? whenTested(screen, part, runDate) : DASH,
    },
    spec('Resolution', text(display.resolution)),
    spec('Refresh rate', text(display.refreshRate)),
    // The panel's EDID gives size and resolution; it is not decoded far enough
    // to name the panel technology or its maker.
    spec('Panel type', DASH),
  ];
}

/* ------------------------------------------- additional information rows */

// Presence facts. The capture records no touchpad / webcam / card-reader field
// of its own, so the only honest evidence is the technician's own test: a
// component that PASSED demonstrably exists. A failed test is not evidence
// either way — the part may be missing or may be broken — so it says nothing.
function presenceFromTest(
  view: HardwareTestView,
  component: string,
  hwt: Obj,
  runDate: string,
): TableRow {
  const row = view.rows.find((r) => r.component === component);
  const part = subObject(hwt, componentKey(component));
  if (!row) return { parameter: component, value: DASH };
  if (part.notApplicable === true) {
    return {
      parameter: component,
      value: 'Not fitted',
      details: `Recorded by the technician's ${component.toLowerCase()} test.`,
      testedOn: whenTested(row, part, runDate),
    };
  }
  if (row.tone === 'good') {
    return {
      parameter: component,
      value: 'Present',
      details: `Confirmed by the technician's ${component.toLowerCase()} test.`,
      testedOn: whenTested(row, part, runDate),
    };
  }
  return { parameter: component, value: DASH };
}

function additionalRows(view: HardwareTestView, hwt: Obj, runDate: string): TableRow[] {
  const touchpad = presenceFromTest(view, 'Trackpad', hwt, runDate);
  const webcam = presenceFromTest(view, 'Camera', hwt, runDate);
  return [
    { ...touchpad, parameter: 'Touchpad' },
    { ...webcam, parameter: 'Webcam' },
    // Nothing reads a card reader and nothing tests one.
    spec('Card reader', DASH),
    {
      parameter: 'Photos',
      value: DASH,
      // The photo count belongs to the page's own Photos section, which is fed
      // by a different query; this section is handed the hardware profile only.
      details: 'The photos of this device are listed in the Photos section of this page.',
    },
  ];
}

/* ------------------------------------------------------ audit history rows */

// What this section can honestly say about the device's history: when the
// profile was captured, and what the hardware test run recorded. The full
// lifecycle stream — every action with its date and user — is the page's own
// Lifecycle section, which reads the audit table; repeating it from here would
// mean a second, possibly disagreeing copy.
function auditHistoryRows(
  device: HardwareDeviceHeader | undefined,
  view: HardwareTestView,
  runDate: string,
): TableRow[] {
  const captured = device?.capturedAt ? testDate(device.capturedAt) : DASH;
  return [
    {
      parameter: 'Profile captured',
      value: captured,
      details: 'The most recent audit that wrote this hardware profile.',
    },
    {
      parameter: 'Hardware test',
      value: view.meta || DASH,
      status: view.present ? view.overall : NOT_TESTED,
      details: view.present
        ? view.earlierCount > 0
          ? `${view.earlierCount} earlier result${view.earlierCount === 1 ? '' : 's'} on record.`
          : undefined
        : NO_TEST_ON_RECORD,
      testedOn: view.present ? runDate : DASH,
    },
    {
      parameter: 'Full lifecycle',
      value: DASH,
      details:
        'Every recorded action, with its date and user, is listed in the Lifecycle section of this page.',
    },
  ];
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

// The walker's values go through the SAME gate as every designed row: text().
// It is the one place that knows a stored "unknown" is the station's placeholder
// for "we did not find out", not an answer — and the capture really does store
// it (a pre-C5 drive's smartStatus, display.touchscreen). Formatting a leftover
// with String() instead let that word onto the screen through the back door,
// beside a Health status cell carefully worded as "Not scanned yet". One gate,
// so no future key can leak it either.
function formatValue(v: unknown): string {
  if (Array.isArray(v)) {
    // A list drops its empty and "unknown" entries rather than printing a dash
    // in the middle of a sentence; a list of nothing but those is nothing.
    const parts = v.map(formatValue).filter((p) => p !== DASH);
    return parts.length > 0 ? parts.join(', ') : DASH;
  }
  if (isObj(v)) return JSON.stringify(v);
  return text(v);
}

// Every profile key the groups above already show, so the fallback lists what is
// genuinely left over rather than repeating the whole profile. The owner's
// category rows are a smaller set than the capture records — a Dell service tag,
// a CPU generation, a drive's SMART verdict — and everything they leave out
// lands in "Other captured details" rather than disappearing.
const GROUP_KEYS: Record<string, string[]> = {
  identification: [
    'manufacturer', 'model', 'productName', 'productFamily', 'deviceType',
    'serialNumber', 'biosUuid', 'assetTag', 'skuNumber', 'sku', 'partNumber',
  ],
  system: [
    'biosVendor', 'biosManufacturer', 'biosVersion', 'biosReleaseDate', 'bootMode',
    'secureBoot', 'tpmVersion', 'os', 'osVersion', 'osBuild', 'osArchitecture',
    'osInstalledOn', 'osProductId',
  ],
  cpu: ['model', 'cores', 'threads', 'baseClock', 'maxClock'],
  memory: ['type', 'totalGb', 'speed', 'modules', 'slots'],
  display: ['size', 'resolution', 'refreshRate'],
  battery: ['health', 'designCapacity', 'fullChargeCapacity', 'cycleCount', 'status'],
  network: [
    'wifi', 'ethernet', 'bluetooth', 'macAddress', 'macAddressWifi', 'wifiMac',
    'macAddressEthernet', 'ethernetMac',
  ],
  // BitLocker and the BIOS password are not repeated here on purpose: they are
  // lock facts, shown in full by the Device locks section above. They still
  // appear below as leftovers, so nothing is lost.
  security: ['tpm', 'secureBoot'],
};

// Per-drive keys the Storage group already shows, plus two that must never be
// printed raw: `health` is the C5 object the Health status row words, and
// `healthPct` is the pre-C5 engine's single-attribute wear figure — computed a
// different way, so beside the real percentage it would read as a second,
// contradicting health score.
const DRIVE_GROUP_KEYS = [
  'model', 'type', 'capacity', 'health', 'healthPct', 'powerOnHours', 'temperatureC',
];

const GPU_GROUP_KEYS = ['model', 'vram'];

// Rendered by their own sections elsewhere on the page, by the test group above,
// or by a group of their own: `locks` is the Device locks section, `driveHealth`
// is the old kiosk's unprivileged SMART probe (superseded by each drive's own
// health), `hardwareTest` would print audio-mixer commands and colour swatches
// verbatim, and `hiddenStorage` has its own Storage group — printed raw here as
// well, its C5 health object would arrive as a line of JSON.
const HANDLED_ELSEWHERE = new Set(['locks', 'driveHealth', 'hardwareTest', 'hiddenStorage']);

// Per-entry keys the hidden-storage group already shows.
const HIDDEN_GROUP_KEYS = ['controller', 'count', 'health'];

const CATEGORY_LABELS: Record<string, string> = {
  identification: 'Device information',
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

interface WalkRow {
  label: string;
  value: string;
}

// "Other captured details" lists what was captured, so a key whose value comes
// back as the dash is dropped entirely rather than listed as a leftover with
// nothing in it. formatValue decides that — null, "", and "unknown" all arrive
// here as DASH.
function leftoverRows(obj: Obj, shown: string[]): WalkRow[] {
  return Object.entries(obj)
    .filter(([k]) => !shown.includes(k))
    .map(([k, v]) => ({ label: humanize(k), value: formatValue(v) }))
    .filter((r) => r.value !== DASH);
}

// Anything in the profile that no group above claimed: a leftover key inside a
// category we do render, a whole category we do not, or a key the capture tool
// starts sending tomorrow. The point is that nothing can silently disappear from
// this page just because no group was written for it.
function otherCapturedRows(profile: Obj): WalkRow[] {
  const rows: WalkRow[] = [];
  const push = (group: string, source: WalkRow[]) => {
    source.forEach((r) => rows.push({ ...r, label: `${group} — ${r.label}` }));
  };
  // A bare value that is not inside an object still goes through formatValue and
  // is still dropped when it formats to a dash, so the two paths into this list
  // cannot disagree about what counts as captured.
  const pushValue = (label: string, value: unknown) => {
    const formatted = formatValue(value);
    if (formatted !== DASH) rows.push({ label, value: formatted });
  };

  for (const [category, shown] of Object.entries(GROUP_KEYS)) {
    push(
      CATEGORY_LABELS[category] ?? humanize(category),
      leftoverRows(subObject(profile, category), shown),
    );
  }
  subArray(profile, 'storage').forEach((drive, i) => {
    push(`Storage drive ${i + 1}`, leftoverRows(drive, DRIVE_GROUP_KEYS));
  });
  subArray(profile, 'hiddenStorage').forEach((entry, i) => {
    push(`Hidden storage ${i + 1}`, leftoverRows(entry, HIDDEN_GROUP_KEYS));
  });
  subArray(profile, 'graphics').forEach((gpu, i) => {
    push(`GPU ${i + 1}`, leftoverRows(gpu, GPU_GROUP_KEYS));
  });

  for (const [key, value] of Object.entries(profile)) {
    // hasOwnProperty, not `in`: a profile key called "constructor" or "toString"
    // would otherwise match Object's prototype and be dropped silently.
    if (Object.prototype.hasOwnProperty.call(GROUP_KEYS, key)) continue;
    if (key === 'storage' || key === 'graphics') continue;
    if (HANDLED_ELSEWHERE.has(key)) continue;
    const label = CATEGORY_LABELS[key] ?? humanize(key);
    if (Array.isArray(value)) {
      value.forEach((el, i) => {
        if (isObj(el)) push(`${label} ${i + 1}`, leftoverRows(el, []));
        else pushValue(`${label} ${i + 1}`, el);
      });
    } else if (isObj(value)) {
      push(label, leftoverRows(value, []));
    } else {
      pushValue(label, value);
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
  const system = subObject(profile, 'system');
  const hwt = subObject(profile, 'hardwareTest');
  const testView = hardwareTestView(profile.hardwareTest);
  const runDate = testDate(hwt.testedAt);
  // An absent battery object means a desktop or a pre-battery capture, not a
  // reading of zero — the group says which rather than showing five dashes.
  const battery = subObject(profile, 'battery');
  const hasBattery = isObj(profile.battery) && Object.values(profile.battery as Obj).some(has);
  const other = otherCapturedRows(profile);

  const groups: Group[] = [
    {
      key: 'device',
      title: 'Device information',
      icon: 'device',
      rows: deviceInformationRows(ident),
    },
    {
      key: 'bios',
      title: 'BIOS / firmware',
      icon: 'firmware',
      rows: biosRows(system, subObject(profile, 'security')),
    },
    {
      key: 'os',
      title: 'Operating system',
      icon: 'os',
      rows: operatingSystemRows(system),
    },
    { key: 'cpu', title: 'Processor', icon: 'cpu', rows: processorRows(subObject(profile, 'cpu')) },
    { key: 'memory', title: 'Memory', icon: 'memory', rows: memoryRows(subObject(profile, 'memory')) },
    ...storageGroups(profile),
    { key: 'graphics', title: 'Graphics', icon: 'graphics', rows: graphicsRows(subArray(profile, 'graphics')) },
    {
      key: 'display',
      title: 'Display',
      icon: 'display',
      rows: displayRows(subObject(profile, 'display'), testView, hwt, runDate),
    },
    { key: 'battery', title: 'Battery', icon: 'battery', rows: batteryRows(battery, hasBattery) },
    { key: 'network', title: 'Network', icon: 'network', rows: networkRows(subObject(profile, 'network')) },
    {
      key: 'tests',
      title: 'Hardware test results',
      icon: 'test',
      rows: hardwareTestRows(testView, hwt, runDate),
    },
    {
      key: 'additional',
      title: 'Additional information',
      icon: 'info',
      rows: additionalRows(testView, hwt, runDate),
    },
    {
      key: 'audit',
      title: 'Audit history',
      icon: 'history',
      rows: auditHistoryRows(device, testView, runDate),
    },
  ];

  if (other.length > 0) {
    groups.push({
      key: 'other',
      title: 'Other captured details',
      icon: 'other',
      rows: other.map((r) => spec(r.label, r.value)),
    });
  }

  // min-w-0 on the section below is load-bearing, not decoration: the section is
  // a CSS grid item, and a grid item's default min-width is auto, so the table's
  // own minimum width would stretch the section past the viewport and scroll the
  // WHOLE page sideways on a phone. With it, the table scrolls inside its own
  // box and the page itself does not move.
  return (
    <section className="md:col-span-2 min-w-0 rounded-xl border border-neutral-200 bg-white p-4">
      {/* The title block. No Edit / Export / Refresh buttons: this page has no
          handler for any of them, and a button that does nothing is worse than
          no button at all. */}
      <div className="flex items-start gap-2">
        <Icon name="device" />
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">
            Hardware profile
          </h2>
          <p className="mt-0.5 text-sm text-neutral-600">
            Device hardware, system information and test results.{' '}
            <span className="text-neutral-500">Auto-captured · read-only</span>
          </p>
        </div>
      </div>

      <DeviceBar ident={ident} device={device} />

      {/* The hardware test's own headline, said once here rather than repeated
          on every test row below. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-600">
        {testView.present ? (
          <>
            <span className="font-semibold uppercase tracking-wide text-neutral-700">
              Hardware test
            </span>
            <Badge label={testView.overall.label} tone={testView.overall.tone} />
            {testView.meta && <span>{testView.meta}</span>}
            {testView.earlierCount > 0 && (
              <span className="text-neutral-500">
                {testView.earlierCount} earlier result{testView.earlierCount === 1 ? '' : 's'} on
                record
              </span>
            )}
          </>
        ) : (
          <span>{NO_TEST_ON_RECORD} Every test row below reads “Not tested”.</span>
        )}
      </div>

      {/* Said once, quietly: what the dash means, and why some rows never fill. */}
      <p className="mt-1 text-xs text-neutral-500">
        A dash ({DASH}) means the audit did not capture that value — it is not a reading of zero or
        none. A few rows the design asks for, such as used and free space, are never read by the
        capture and so always show one.
      </p>

      <ProfileTable groups={groups} />
    </section>
  );
}
