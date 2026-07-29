// Normalisation rules for auto-captured specs.
//
// These live at the API boundary on purpose. Both the USB audit tool and the
// manual "add asset" form feed the same ingest path, and every reader (web app,
// label, xlsx export, reports) trusts what the API stored. Normalising once on
// write means no consumer needs to know these rules — as opposed to fixing the
// display in each of the places that renders a spec, which is how you end up
// with a label and an export that disagree.

/**
 * Round an installed-RAM figure up to the nearest even GB.
 *
 * `/proc/meminfo` reports memory the OS can *use*, which is installed capacity
 * minus whatever the firmware reserved (integrated graphics, management engine).
 * That is why real machines report 7, 15 or 31 GB — none of which is a capacity
 * you can buy. Rounding up to the nearest even value recovers the true figure
 * for every standard configuration: 7 -> 8, 15 -> 16, 31 -> 32, and it also
 * covers the mixed-module sizes that are genuinely even (6, 12, 24 stay put).
 *
 * The audit tool now sums the DIMM sizes from dmidecode, which is exact, so this
 * is a guard rather than the primary mechanism: it catches older versions of the
 * tool, hand-typed entries, and machines where dmidecode is unavailable.
 */
export function standardiseRamGb(gb: number | null | undefined): number | null {
  if (gb == null) return null;
  const n = Number(gb);
  // 4 TB is well past any machine we handle; anything beyond it is a bad parse.
  if (!Number.isFinite(n) || n <= 0 || n > 4096) return null;
  return Math.ceil(n / 2) * 2;
}

// Panel sizes that actually exist, laptop and monitor. EDID encodes the physical
// image size in millimetres, so the computed diagonal lands a few tenths off the
// marketed size (a 14" panel is 309x174mm -> 13.96"); snapping to this list is
// what turns that into the "14"" an operator expects to read.
const STANDARD_SCREEN_SIZES = [
  10.1, 11.6, 12.0, 12.1, 12.5, 13.0, 13.3, 13.5, 14.0, 15.0, 15.6, 16.0, 17.0, 17.3, 18.4, 19.5,
  21.5, 23.0, 23.8, 24.0, 27.0, 32.0,
];

// How far off a standard size we still snap. 0.4" is wider than the worst
// millimetre-rounding error and narrower than the gap between adjacent sizes,
// so 13.24" -> 13.3" while a genuinely odd panel keeps its measured value.
const SNAP_TOLERANCE_IN = 0.4;

function formatInches(inches: number): string {
  // Nearest, not first-within-tolerance: adjacent sizes are closer together than
  // the tolerance (13.0 and 13.3), so scanning in order would snap 13.3" to 13".
  const nearest = STANDARD_SCREEN_SIZES.reduce((best, s) =>
    Math.abs(s - inches) < Math.abs(best - inches) ? s : best,
  );
  const snapped =
    Math.abs(nearest - inches) <= SNAP_TOLERANCE_IN ? nearest : Math.round(inches * 10) / 10;
  // 14 prints as 14", 15.6 as 15.6" — no trailing ".0".
  return `${Number.isInteger(snapped) ? snapped : snapped.toFixed(1)}"`;
}

/**
 * Coerce any screen-size value we have ever stored into a consistent `14"`.
 *
 * Handles the shapes actually present in the data: `14"` (already good), `13.3`
 * (no inch mark), and EDID's raw `310 mm x 170 mm`, which earlier versions of
 * the audit tool wrote straight through and which would otherwise print on a
 * label as "310 MM X 170 MM". Returns null for anything that is not plausibly a
 * screen size, so a bad parse leaves the field blank rather than printing junk.
 */
export function normaliseScreenSize(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // "310 mm x 170 mm" / "310x170mm" -> diagonal in inches.
  if (/mm/i.test(s)) {
    const mm = s.match(/(\d+(?:\.\d+)?)/g)?.map(Number) ?? [];
    if (mm.length >= 2 && mm[0] > 0 && mm[1] > 0) {
      const inches = Math.hypot(mm[0], mm[1]) / 25.4;
      return inches >= 7 && inches <= 40 ? formatInches(inches) : null;
    }
    return null;
  }

  // A resolution is not a size — "1920x1080" must not become 1920".
  if (/^\s*\d{3,}\s*[x×]\s*\d{3,}\s*$/i.test(s)) return null;

  const n = Number(s.match(/(\d+(?:\.\d+)?)/)?.[1]);
  if (!Number.isFinite(n) || n < 7 || n > 40) return null;
  return formatInches(n);
}

// Chassis types with a built-in panel.
const LAPTOP_TYPES = new Set(['laptop', 'notebook', 'portable', 'convertible', 'detachable']);

// Chassis types we know have NO integrated display. This is deliberately a
// positive list rather than "anything that isn't a laptop": a real Latitude 7490
// in the data has deviceType null and category "Laptop", and treating unknown as
// desktop would have deleted its correct 14". Unknown means unknown — leave the
// captured value alone and let the operator see it.
//
// All-in-ones are absent on purpose: their panel size IS meaningful, but the audit
// tool reports them as "Desktop", so there is no way to tell one from a tower here.
// Monitors are absent too — a monitor's size is its headline spec, not noise.
const NO_PANEL_TYPES = new Set([
  'desktop',
  'tower',
  'sff',
  'small form factor',
  'micro',
  'mini',
  'mini pc',
  'server',
  'workstation',
  'thin client',
  'blade',
  'rack',
  'node',
]);

function normaliseType(deviceType: string | null | undefined): string {
  return (deviceType ?? '').trim().toLowerCase();
}

/** True when the device is known to have an integrated display. */
export function hasBuiltInDisplay(deviceType: string | null | undefined): boolean {
  return LAPTOP_TYPES.has(normaliseType(deviceType));
}

/** True only when the device is known NOT to have one. Unknown returns false. */
export function lacksBuiltInDisplay(deviceType: string | null | undefined): boolean {
  return NO_PANEL_TYPES.has(normaliseType(deviceType));
}

/**
 * The screen size to store/show for a device: null for anything known to have no
 * panel, a normalised value otherwise.
 *
 * Pass the best type information available — `deviceType ?? category` — because
 * rows captured before deviceType existed carry the chassis in `category`.
 */
export function screenSizeFor(
  deviceType: string | null | undefined,
  raw: string | null | undefined,
): string | null {
  return lacksBuiltInDisplay(deviceType) ? null : normaliseScreenSize(raw);
}
