// The full auto-captured hardware profile from the audit tool.
//
// Stored as JSONB (assets.hardware_profile + a snapshot per asset_audits row) so
// the capture tool can add new attributes over time WITHOUT a schema migration —
// unknown keys are simply persisted and rendered. Every field is optional because
// a wiped, live-booted machine yields a different subset each time. The trailing
// index signatures keep it forward-compatible at the type level too.
export interface HardwareProfile {
  identification?: {
    manufacturer?: string;
    model?: string; // friendly marketing name, e.g. "ThinkPad T440" / "Latitude 5420"
    productName?: string; // raw SMBIOS product name / machine-type code
    productFamily?: string;
    deviceType?: string; // Laptop | Desktop | Workstation | Server | Monitor
    serialNumber?: string;
    serviceTag?: string;
    expressServiceCode?: string; // Dell — derived from the service tag
    biosUuid?: string;
    assetTag?: string;
    [key: string]: unknown;
  };
  system?: {
    os?: string;
    osVersion?: string;
    osBuild?: string;
    biosVersion?: string;
    biosReleaseDate?: string;
    bootMode?: string; // UEFI | Legacy
    secureBoot?: string; // enabled | disabled | unknown
    tpmVersion?: string;
    [key: string]: unknown;
  };
  cpu?: {
    manufacturer?: string;
    model?: string;
    generation?: string;
    cores?: number;
    threads?: number;
    baseClock?: string;
    maxClock?: string;
    [key: string]: unknown;
  };
  memory?: {
    totalGb?: number;
    type?: string; // DDR3 | DDR4 | DDR5
    speed?: string;
    modules?: number;
    slots?: number;
    maxGb?: number;
    [key: string]: unknown;
  };
  // One entry per installed drive.
  storage?: Array<{
    manufacturer?: string;
    model?: string;
    capacity?: string;
    type?: string; // SSD | HDD | NVMe
    interface?: string; // SATA | NVMe
    smartStatus?: string; // PASSED | FAILED | unknown
    serialNumber?: string;
    [key: string]: unknown;
  }>;
  graphics?: Array<{
    manufacturer?: string;
    model?: string;
    type?: string; // Integrated | Dedicated
    vram?: string;
    [key: string]: unknown;
  }>;
  display?: {
    size?: string;
    resolution?: string;
    touchscreen?: string; // yes | no | unknown
    refreshRate?: string;
    [key: string]: unknown;
  };
  battery?: {
    health?: string;
    designCapacity?: string;
    fullChargeCapacity?: string;
    cycleCount?: number;
    status?: string; // charging | discharging | full
    [key: string]: unknown;
  };
  network?: {
    ethernet?: string;
    wifi?: string;
    bluetooth?: string;
    macAddress?: string;
    [key: string]: unknown;
  };
  security?: {
    tpm?: string;
    secureBoot?: string;
    bitlocker?: string;
    biosPassword?: string;
    [key: string]: unknown;
  };
  // Anything the tool starts sending later lands here untouched.
  [key: string]: unknown;
}
