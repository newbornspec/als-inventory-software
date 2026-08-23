// Flattening a captured hardware profile into component rows.
//
// Shared so the Goods In workspace and the Audit workspace present a device's
// components identically — the same machine must not read one way on one
// screen and another way on the next.

// The subset of the captured profile these tables render. Every field is
// optional: a wiped, live-booted machine yields a different set each time, and
// hand-entered devices may carry almost nothing.
export interface HardwareProfileLike {
  identification?: { manufacturer?: string; model?: string; productName?: string };
  system?: {
    os?: string;
    osVersion?: string;
    biosVersion?: string;
    bootMode?: string;
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
  display?: { size?: string; resolution?: string; touchscreen?: string };
  battery?: {
    health?: string;
    designCapacity?: string;
    fullChargeCapacity?: string;
    cycleCount?: number;
  };
}

export interface SpecRow {
  category: string;
  qty: number;
  manufacturer: string;
  model: string;
  serial: string;
  size: string;
  speed: string;
  details: string;
}

// The flat summary an audit event records even when no full profile blob was
// captured (the offline audit form writes only these promoted columns).
export interface PromotedSpec {
  cpu?: string | null;
  ramGb?: number | null;
  storageCapacity?: string | null;
  screenSize?: string | null;
  screenResolution?: string | null;
  batteryHealth?: string | null;
}

const join = (parts: (string | number | undefined | null | false)[]) =>
  parts.filter(Boolean).join(' · ');

// Rows for the categories the profile actually carries. A category is emitted
// only when the capture holds something for it — an empty line says nothing
// worth a row. Each guard covers EVERY field its row can render, so a partial
// capture (a battery with only a cycle count, say) is never silently dropped.
export function specRows(p: HardwareProfileLike | null | undefined): SpecRow[] {
  if (!p) return [];
  const rows: SpecRow[] = [];

  if (p.cpu?.model || p.cpu?.manufacturer) {
    rows.push({
      category: 'CPU',
      qty: 1,
      manufacturer: p.cpu.manufacturer ?? '—',
      model: p.cpu.model ?? '—',
      serial: '—',
      size: '—',
      speed: join([p.cpu.baseClock, p.cpu.maxClock && `boost ${p.cpu.maxClock}`]) || '—',
      details:
        join([
          p.cpu.cores != null && `${p.cpu.cores} cores`,
          p.cpu.threads != null && `${p.cpu.threads} threads`,
          p.cpu.generation,
        ]) || '—',
    });
  }

  if (
    p.memory?.totalGb != null ||
    p.memory?.type ||
    p.memory?.speed ||
    p.memory?.modules != null
  ) {
    rows.push({
      category: 'RAM',
      qty: p.memory.modules ?? 1,
      manufacturer: '—',
      model: p.memory.type ?? '—',
      serial: '—',
      size: p.memory.totalGb != null ? `${p.memory.totalGb} GB` : '—',
      speed: p.memory.speed ?? '—',
      details:
        join([
          p.memory.slots != null && `${p.memory.slots} slots`,
          p.memory.maxGb != null && `max ${p.memory.maxGb} GB`,
        ]) || '—',
    });
  }

  for (const d of p.storage ?? []) {
    rows.push({
      category: 'Storage',
      qty: 1,
      manufacturer: d.manufacturer ?? '—',
      model: d.model ?? '—',
      serial: d.serialNumber ?? '—',
      size: d.capacity ?? '—',
      speed: d.interface ?? '—',
      details: join([d.type, d.smartStatus && `SMART ${d.smartStatus}`]) || '—',
    });
  }

  for (const g of p.graphics ?? []) {
    rows.push({
      category: 'Graphics',
      qty: 1,
      manufacturer: g.manufacturer ?? '—',
      model: g.model ?? '—',
      serial: '—',
      size: g.vram ?? '—',
      speed: '—',
      details: g.type ?? '—',
    });
  }

  if (p.display?.size || p.display?.resolution) {
    rows.push({
      category: 'Display',
      qty: 1,
      manufacturer: '—',
      model: '—',
      serial: '—',
      size: p.display.size ?? '—',
      speed: '—',
      details:
        join([p.display.resolution, p.display.touchscreen === 'yes' && 'touchscreen']) || '—',
    });
  }

  if (
    p.battery?.health ||
    p.battery?.fullChargeCapacity ||
    p.battery?.designCapacity ||
    p.battery?.cycleCount != null
  ) {
    rows.push({
      category: 'Battery',
      qty: 1,
      manufacturer: '—',
      model: '—',
      serial: '—',
      size: p.battery.fullChargeCapacity ?? p.battery.designCapacity ?? '—',
      speed: '—',
      details:
        join([
          p.battery.health && `health ${p.battery.health}`,
          p.battery.cycleCount != null && `${p.battery.cycleCount} cycles`,
        ]) || '—',
    });
  }

  if (p.system?.os || p.system?.biosVersion || p.system?.bootMode || p.system?.tpmVersion) {
    rows.push({
      category: 'System',
      qty: 1,
      manufacturer: '—',
      model: join([p.system.os, p.system.osVersion]) || '—',
      serial: '—',
      size: '—',
      speed: '—',
      details:
        join([
          p.system.biosVersion && `BIOS ${p.system.biosVersion}`,
          p.system.bootMode,
          p.system.tpmVersion && `TPM ${p.system.tpmVersion}`,
        ]) || '—',
    });
  }

  return rows;
}

// Fallback for an audit that stored no profile blob — the offline audit form
// writes only the promoted columns. A short summary of what WAS recorded beats
// "nothing captured" printed over data that exists.
export function promotedSpecRows(s: PromotedSpec | null | undefined): SpecRow[] {
  if (!s) return [];
  const blank = { manufacturer: '—', model: '—', serial: '—', size: '—', speed: '—', details: '—' };
  const rows: SpecRow[] = [];
  if (s.cpu) rows.push({ ...blank, category: 'CPU', qty: 1, model: s.cpu });
  if (s.ramGb != null) rows.push({ ...blank, category: 'RAM', qty: 1, size: `${s.ramGb} GB` });
  if (s.storageCapacity) {
    rows.push({ ...blank, category: 'Storage', qty: 1, size: s.storageCapacity });
  }
  if (s.screenSize || s.screenResolution) {
    rows.push({
      ...blank,
      category: 'Display',
      qty: 1,
      size: s.screenSize ?? '—',
      details: s.screenResolution ?? '—',
    });
  }
  if (s.batteryHealth) {
    rows.push({ ...blank, category: 'Battery', qty: 1, details: `health ${s.batteryHealth}` });
  }
  return rows;
}
