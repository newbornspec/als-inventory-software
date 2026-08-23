// Turning a captured hardware profile into the component-specification rows
// the app shows wherever a device's hardware is displayed.
//
// The presentation is deliberately dense: one row per component, with the
// parameters COMPOSED into a single readable cell ("i3-8145U 2.10GHz (3.9GHz
// boost, 2c/4t, 8th Gen)") rather than spread across a column per attribute.
// A wide sparse grid forced the reader to scan sideways past empty cells to
// assemble the one sentence they wanted.
//
// Shared so the Audit workspace and the Goods In panel render a machine
// identically — the same device must not read one way on one screen and
// another way on the next.

export interface HardwareProfileLike {
  identification?: { manufacturer?: string; model?: string; productName?: string };
  system?: {
    os?: string;
    osVersion?: string;
    biosVersion?: string;
    bootMode?: string;
    secureBoot?: string;
    tpmVersion?: string;
  };
  cpu?: {
    manufacturer?: string;
    model?: string;
    generation?: string;
    cores?: number;
    threads?: number;
    baseClock?: string;
    maxClock?: string;
  };
  memory?: {
    totalGb?: number;
    type?: string;
    speed?: string;
    modules?: number;
    slots?: number;
    maxGb?: number;
  };
  storage?: Array<{
    manufacturer?: string;
    model?: string;
    capacity?: string;
    type?: string;
    interface?: string;
    smartStatus?: string;
    serialNumber?: string;
  }>;
  graphics?: Array<{ manufacturer?: string; model?: string; type?: string; vram?: string }>;
  // manufacturer/panel are not captured by every tool, but the schema is
  // open-ended and some report them — shown when present.
  display?: { manufacturer?: string; size?: string; resolution?: string; touchscreen?: string };
  battery?: {
    manufacturer?: string;
    health?: string;
    designCapacity?: string;
    fullChargeCapacity?: string;
    cycleCount?: number;
  };
}

// A flag rendered beside the parameters — reserved for facts an operator must
// not miss, like a drive that failed SMART.
export interface SpecFlag {
  label: string;
  tone: 'bad' | 'warn' | 'good';
}

export interface SpecRow {
  component: string;
  qty: number;
  // The manufacturer, or the architecture token that identifies the part:
  // "Intel" for a CPU, "DDR4" for memory, "NVMe Samsung" for a drive,
  // "BIOS 1.7.4" for the system row.
  mfgArch: string;
  // The part and its parameters, composed into one line.
  params: string;
  // Chain-of-custody detail (drive serials), shown small under the params.
  sub?: string;
  flag?: SpecFlag;
}

export interface PromotedSpec {
  cpu?: string | null;
  ramGb?: number | null;
  storageCapacity?: string | null;
  screenSize?: string | null;
  screenResolution?: string | null;
  batteryHealth?: string | null;
}

const DASH = '—';
const text = (parts: (string | number | undefined | null | false)[], sep = ' ') =>
  parts.filter((p) => p !== undefined && p !== null && p !== false && p !== '').join(sep);
// "a, b, c" wrapped in parentheses — omitted entirely when nothing qualifies.
const paren = (parts: (string | number | undefined | null | false)[]) => {
  const inner = text(parts, ', ');
  return inner ? `(${inner})` : '';
};

// A drive that failed SMART is the single most consequential thing on this
// table: it decides whether the unit can be sold or must be destroyed.
function smartFlag(status?: string): SpecFlag | undefined {
  if (!status) return undefined;
  const s = status.toUpperCase();
  if (s.includes('FAIL')) return { label: 'SMART FAILED', tone: 'bad' };
  return undefined;
}

export function specRows(p: HardwareProfileLike | null | undefined): SpecRow[] {
  if (!p) return [];
  const rows: SpecRow[] = [];

  if (p.cpu?.model || p.cpu?.manufacturer) {
    const c = p.cpu;
    rows.push({
      component: 'CPU',
      qty: 1,
      mfgArch: c.manufacturer || DASH,
      params:
        text([
          text([c.model, c.baseClock]),
          paren([
            c.maxClock && `${c.maxClock} boost`,
            c.cores != null && `${c.cores}c${c.threads != null ? `/${c.threads}t` : ''}`,
            c.generation,
          ]),
        ]) || DASH,
    });
  }

  if (
    p.memory?.totalGb != null ||
    p.memory?.type ||
    p.memory?.speed ||
    p.memory?.modules != null
  ) {
    const m = p.memory;
    rows.push({
      component: 'RAM',
      qty: 1,
      mfgArch: m.type || DASH,
      params:
        text([
          text([m.totalGb != null && `${m.totalGb}GB`, m.speed]),
          paren([
            m.modules != null && `${m.modules} slot${m.modules === 1 ? '' : 's'}`,
            m.slots != null && m.modules == null && `${m.slots} slots`,
            m.maxGb != null && `max ${m.maxGb}GB`,
          ]),
        ]) || DASH,
    });
  }

  for (const d of p.storage ?? []) {
    rows.push({
      component: 'Storage',
      qty: 1,
      mfgArch: text([d.type || d.interface, d.manufacturer]) || DASH,
      params: text([d.capacity, d.model && d.model !== d.capacity && d.model]) || DASH,
      sub: d.serialNumber ? `S/N ${d.serialNumber}` : undefined,
      flag: smartFlag(d.smartStatus),
    });
  }

  for (const g of p.graphics ?? []) {
    rows.push({
      component: 'Graphics',
      qty: 1,
      mfgArch: g.manufacturer || DASH,
      params: text([g.model, g.type, g.vram]) || DASH,
    });
  }

  if (p.display?.size || p.display?.resolution) {
    rows.push({
      component: 'Display',
      qty: 1,
      mfgArch: p.display.manufacturer || DASH,
      params:
        text([
          text([p.display.size, p.display.resolution]),
          p.display.touchscreen === 'yes' ? '(touchscreen)' : '',
        ]) || DASH,
    });
  }

  if (
    p.battery?.health ||
    p.battery?.fullChargeCapacity ||
    p.battery?.designCapacity ||
    p.battery?.cycleCount != null
  ) {
    const b = p.battery;
    rows.push({
      component: 'Battery',
      qty: 1,
      mfgArch: b.manufacturer || DASH,
      params:
        text([
          b.health ? `Health: ${b.health}` : '',
          paren([
            b.fullChargeCapacity &&
              text([b.fullChargeCapacity, b.designCapacity && `of ${b.designCapacity}`]),
            b.cycleCount != null && `${b.cycleCount} cycles`,
          ]),
        ]) || DASH,
    });
  }

  if (p.system?.os || p.system?.biosVersion || p.system?.bootMode || p.system?.tpmVersion) {
    const s = p.system;
    rows.push({
      component: 'System',
      qty: 1,
      mfgArch: s.biosVersion ? `BIOS ${s.biosVersion}` : DASH,
      params:
        text([
          s.bootMode,
          s.tpmVersion && `TPM ${s.tpmVersion}`,
          s.secureBoot && `Secure Boot ${s.secureBoot}`,
        ]) || DASH,
      sub: text([s.os, s.osVersion]) || undefined,
    });
  }

  return rows;
}

// Fallback for an audit that stored no profile blob — the offline form records
// only these promoted columns. A short summary of what WAS recorded beats
// "nothing captured" printed over data that exists.
export function promotedSpecRows(s: PromotedSpec | null | undefined): SpecRow[] {
  if (!s) return [];
  const rows: SpecRow[] = [];
  if (s.cpu) rows.push({ component: 'CPU', qty: 1, mfgArch: DASH, params: s.cpu });
  if (s.ramGb != null) rows.push({ component: 'RAM', qty: 1, mfgArch: DASH, params: `${s.ramGb}GB` });
  if (s.storageCapacity) {
    rows.push({ component: 'Storage', qty: 1, mfgArch: DASH, params: s.storageCapacity });
  }
  if (s.screenSize || s.screenResolution) {
    rows.push({
      component: 'Display',
      qty: 1,
      mfgArch: DASH,
      params: text([s.screenSize, s.screenResolution]),
    });
  }
  if (s.batteryHealth) {
    rows.push({
      component: 'Battery',
      qty: 1,
      mfgArch: DASH,
      params: `Health: ${s.batteryHealth}`,
    });
  }
  return rows;
}
