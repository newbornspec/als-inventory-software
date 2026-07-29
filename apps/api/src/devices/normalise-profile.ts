import { HardwareProfile } from './hardware-profile.type';
import { screenSizeFor, standardiseRamGb } from '../common/spec-normalise';

/**
 * Apply the spec normalisation rules to a captured hardware profile.
 *
 * The profile is what the xlsx lot report and the asset detail page read, so
 * normalising only the flat audit columns would leave the export showing "15 GB"
 * while the label showed "16 GB". Returns a new object — the caller's profile is
 * never mutated, since the same object is written to two tables.
 *
 * The raw figure is preserved as `memory.detectedGb` whenever it differs from the
 * standardised one, so a diagnostic question ("did this machine really only
 * expose 15 GB to the OS?") is still answerable after the fact.
 */
export function normaliseHardwareProfile(
  profile: HardwareProfile | null,
  deviceType: string | null,
): HardwareProfile | null {
  if (!profile) return null;

  const out: HardwareProfile = { ...profile };

  if (profile.memory) {
    const detected = profile.memory.totalGb ?? null;
    const standard = standardiseRamGb(detected);
    const memory = { ...profile.memory };
    if (standard != null) {
      memory.totalGb = standard;
      if (detected != null && detected !== standard) memory.detectedGb = detected;
    }
    out.memory = memory;
  }

  // A desktop has no built-in panel, so any size on one is stale or mis-detected.
  const size = screenSizeFor(
    deviceType ?? profile.identification?.deviceType ?? null,
    profile.display?.size,
  );
  if (profile.display) {
    const display = { ...profile.display };
    if (size) display.size = size;
    else delete display.size;
    // Drop the section entirely rather than leave an empty object in the JSON.
    out.display = Object.keys(display).length ? display : undefined;
    if (!out.display) delete out.display;
  }

  return out;
}
