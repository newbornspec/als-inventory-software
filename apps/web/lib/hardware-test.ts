// How the technician Hardware Test (contract C6, profile.hardwareTest) is WORDED
// for a human — on the asset page today, and ready for the reports the same way
// each drive's health is. The stored object is a machine record full of jargon a
// buyer should never see (audio mixer commands, sink names, the exact keys a
// keyboard was missing, colour swatches shown on screen, raw pass/fail booleans,
// and a running history log). This turns all of that into plain English.
//
// Kept dependency-free (no imports), exactly like lib/drive-health.ts, so the
// API jest suite can import this same file by relative path and prove the asset
// page and the reports word a result identically. Every field is stick-supplied
// and optional, so nothing here assumes a shape: a missing or garbage piece
// degrades to a short honest line, never a crash and never a raw blob.
//
// Rules this file enforces (owner's request, 2026-09-20):
//   - The overall verdict is READ from the stored status, never invented. An
//     unfinished run has no verdict, only "3 of 5 tested".
//   - "Unknown" is never a word we print. A test with nothing to say degrades to
//     a neutral, plain line.
//   - Colour is never the only signal: every status is carried as words too, so
//     the tone here is only ever a hint alongside the label.

export type HwTestTone = 'good' | 'warn' | 'bad' | 'neutral';

export interface HardwareTestRow {
  // "Speaker" | "Keyboard" | "Camera" | "Screen" | "Trackpad"
  component: string;
  // "Passed" | "Needs attention" | "Failed" | "N/A" | "Testing" | "Not tested"
  statusLabel: string;
  tone: HwTestTone;
  // Plain English, e.g. "Both speakers work — working both". May be '' when a
  // component was not tested and left nothing worth a sentence.
  summary: string;
}

export interface HardwareTestView {
  // false for a device with no hardware test on record — the card renders nothing.
  present: boolean;
  // "Passed" (good) / "Needs attention" (warn) / "Failed" (bad), or, for a run
  // that is not finished, "3 of 5 tested" (neutral — no verdict).
  overall: { label: string; tone: HwTestTone };
  // "Tested by <technician> · 20 Sep 2026" (· clock not network-synced), or ''.
  meta: string;
  // One row per component, always in this order.
  rows: HardwareTestRow[];
  // Length of the stored history log, for an optional quiet footnote. The log
  // itself is never shown.
  earlierCount: number;
}

// The five components, in the order a reader expects them.
const COMPONENTS = ['speaker', 'keyboard', 'camera', 'screen', 'trackpad'] as const;
type Component = (typeof COMPONENTS)[number];

const COMPONENT_LABEL: Record<Component, string> = {
  speaker: 'Speaker',
  keyboard: 'Keyboard',
  camera: 'Camera',
  screen: 'Screen',
  trackpad: 'Trackpad',
};

// A status that counts as a finished test (the station's HWTEST_DONE set).
const DONE = new Set(['PASSED', 'ATTENTION', 'FAILED']);

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// A count the station reported, or null. Negative or non-finite is not a count.
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// Station-supplied text. An empty string or a bare "unknown" placeholder is
// treated as no text at all, so neither can ever reach the screen.
function words(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || /^unknown$/i.test(t)) return null;
  return t;
}

// A stored status, upper-cased for comparison. '' when there is none.
function statusOf(v: unknown): string {
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

// "2026-09-20T15:50:25Z" -> "20 Sep 2026". In UTC so the printed day matches the
// day the station stamped, whatever timezone reads it. '' for a missing or
// unparseable value — never a broken "Invalid Date".
function formatDate(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// One audio channel's outcome: true works, false faulty, null not reported.
// The station may word it as a status string ("PASSED") or a boolean.
function channelWorks(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/pass|work|good|^ok$|^yes$/i.test(v)) return true;
    if (/fail|faulty|bad|dead|^no$/i.test(v)) return false;
  }
  return null;
}

function speakerSummary(part: Obj): string {
  const l = channelWorks(part.left);
  const r = channelWorks(part.right);
  if (l !== null && r !== null) {
    if (l && r) return 'Both speakers work';
    if (l && !r) return 'Left works, right faulty';
    if (!l && r) return 'Right works, left faulty';
    return 'Both speakers faulty';
  }
  // Only one channel reported: say what we know, not a guess about the other.
  if (l !== null) return l ? 'Left speaker works' : 'Left speaker faulty';
  if (r !== null) return r ? 'Right speaker works' : 'Right speaker faulty';
  return '';
}

// The device name the camera reported, tidied for reading: drop the truncated
// trailing vendor half-word after a colon ("...: Integrate") and turn the
// underscores into spaces. "Integrated_Webcam_HD: Integrate" -> "Integrated
// Webcam HD". Nothing usable -> "the camera", so the row still reads as a
// sentence.
function cameraSummary(part: Obj): string {
  const raw = words(part.device);
  if (!raw) return 'the camera';
  const tidy = raw.split(':')[0].replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return tidy || 'the camera';
}

function screenSummary(part: Obj): string {
  const dead = num(part.deadPixels);
  if (dead === null) return '';
  if (dead === 0) return 'No dead pixels';
  return `${dead} dead pixel${dead === 1 ? '' : 's'}`;
}

function trackpadSummary(part: Obj): string {
  // A machine with no trackpad (a desktop) is not a fault: it is benign N/A.
  if (part.notApplicable === true) return 'No trackpad fitted';
  // Name only what the pad did NOT do; the raw booleans never reach the screen.
  const faults: string[] = [];
  if (part.moved === false) faults.push('movement not detected');
  if (part.leftClick === false) faults.push('left button not detected');
  if (part.rightClick === false) faults.push('right button not detected');
  if (part.scrolled === false) faults.push('scrolling not detected');
  if (faults.length) {
    const joined = faults.join(', ');
    return joined.charAt(0).toUpperCase() + joined.slice(1);
  }
  return 'Movement and buttons work';
}

// The plain-English core of a component's summary, before the technician's own
// words are added. Never a raw field, never a count, never a colour list.
function coreSummary(name: Component, part: Obj): string {
  switch (name) {
    case 'speaker':
      return speakerSummary(part);
    // The device type is the useful line ("Laptop – Standard"); the missing-key
    // list and the detected/expected counts are the jargon we drop.
    case 'keyboard':
      return words(part.deviceType) ?? '';
    case 'camera':
      return cameraSummary(part);
    case 'screen':
      return screenSummary(part);
    case 'trackpad':
      return trackpadSummary(part);
  }
}

// The station's own plain-English extras: why a test is not a pass, and any note
// the technician typed. Both are the useful human words, so they are kept; a
// note that merely repeats the reason is not printed twice.
function extras(part: Obj): string[] {
  const out: string[] = [];
  const reason = words(part.reason);
  if (reason) out.push(reason);
  const notes = words(part.notes);
  if (notes && notes !== reason) out.push(notes);
  return out;
}

// The status word + tone for one row. A benign trackpad N/A is stored as PASSED
// so the station's count treats it as satisfied, but it must never read as a
// green "Passed": it is shown neutral, in words, as N/A.
function badge(status: string, notApplicable: boolean): { label: string; tone: HwTestTone } {
  if (notApplicable) return { label: 'N/A', tone: 'neutral' };
  switch (status) {
    case 'PASSED':
      return { label: 'Passed', tone: 'good' };
    case 'ATTENTION':
      return { label: 'Needs attention', tone: 'warn' };
    case 'FAILED':
      return { label: 'Failed', tone: 'bad' };
    case 'IN_PROGRESS':
      return { label: 'Testing', tone: 'neutral' };
    // NOT_TESTED, an unknown word, or nothing at all: honest and neutral, never
    // the word "Unknown".
    default:
      return { label: 'Not tested', tone: 'neutral' };
  }
}

function rowFor(name: Component, part: unknown): HardwareTestRow {
  const p = isObj(part) ? part : {};
  const notApplicable = name === 'trackpad' && p.notApplicable === true;
  const { label, tone } = badge(statusOf(p.status), notApplicable);
  const summary = [coreSummary(name, p), ...extras(p)].filter(Boolean).join(' — ');
  return { component: COMPONENT_LABEL[name], statusLabel: label, tone, summary };
}

function metaLine(t: Obj): string {
  const bits: string[] = [];
  const tech = words(t.technician);
  const date = formatDate(t.testedAt);
  if (tech && date) bits.push(`Tested by ${tech} · ${date}`);
  else if (tech) bits.push(`Tested by ${tech}`);
  else if (date) bits.push(`Tested ${date}`);
  // A quiet caveat only when the station admits its clock was not network-set,
  // so the stamped date could be wrong.
  if (t.clockWasNetwork === false && date) bits.push('clock not network-synced');
  return bits.join(' · ');
}

function overallFor(t: Obj): { label: string; tone: HwTestTone } {
  switch (statusOf(t.status)) {
    case 'PASSED':
      return { label: 'Passed', tone: 'good' };
    case 'ATTENTION':
      return { label: 'Needs attention', tone: 'warn' };
    case 'FAILED':
      return { label: 'Failed', tone: 'bad' };
  }
  // Not a verdict (still running, never started, or a word we don't know): count
  // what is finished and say only that, inventing no pass or fail.
  const total = num(t.total) ?? COMPONENTS.length;
  const completed =
    num(t.completed) ??
    COMPONENTS.filter((c) => DONE.has(statusOf(isObj(t[c]) ? (t[c] as Obj).status : undefined)))
      .length;
  return { label: `${completed} of ${total} tested`, tone: 'neutral' };
}

// The stored profile.hardwareTest object -> everything the card needs to show it
// as a clean human summary.
export function hardwareTestView(hwtest: unknown): HardwareTestView {
  if (!isObj(hwtest)) {
    return {
      present: false,
      overall: { label: 'Not tested', tone: 'neutral' },
      meta: '',
      rows: [],
      earlierCount: 0,
    };
  }
  return {
    present: true,
    overall: overallFor(hwtest),
    meta: metaLine(hwtest),
    rows: COMPONENTS.map((c) => rowFor(c, hwtest[c])),
    earlierCount: Array.isArray(hwtest.history) ? hwtest.history.length : 0,
  };
}

// One report cell for a whole machine's hardware test, the same wording idea as
// the card: "Passed" / "Needs attention: screen" / "Failed: keyboard" /
// "3 of 5 tested". '' when there is no test on record, like a blank battery
// cell. (Exported ready for the batch and pallet reports; not yet wired in — see
// the note in the task.)
export function hardwareTestSummary(hwtest: unknown): string {
  const v = hardwareTestView(hwtest);
  if (!v.present) return '';
  const { tone, label } = v.overall;
  if (tone === 'good') return 'Passed';
  if (tone === 'bad') {
    const named = v.rows.filter((r) => r.tone === 'bad').map((r) => r.component.toLowerCase());
    return named.length ? `Failed: ${named.join(', ')}` : 'Failed';
  }
  if (tone === 'warn') {
    const named = v.rows.filter((r) => r.tone === 'warn').map((r) => r.component.toLowerCase());
    return named.length ? `Needs attention: ${named.join(', ')}` : 'Needs attention';
  }
  // Neutral: an unfinished run carries its own "3 of 5 tested" phrasing.
  return label;
}
