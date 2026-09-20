import { readFileSync } from 'fs';
import { join } from 'path';
import * as api from './hardware-test';
// The web app's copy of the same formatter. Imported by relative path on
// purpose, exactly as drive-health.spec does: every summary case below runs
// through BOTH, so the asset-page card cannot word a hardware test differently
// from the batch and pallet reports.
import * as web from '../../../web/lib/hardware-test';

const COPIES = [
  ['api', api],
  ['web', web],
] as const;

// A finished component in one word. The station stores far more per component
// (mixer commands, key counts, colour swatches); the summary cell only ever
// needs the status, so these fixtures stay small.
const pass = { status: 'PASSED' };

// Contract C6 runs, as the station engine writes them. The overall `status` is
// the worst-wins roll-up the station already computed; the cell reads it, it
// does not re-derive a verdict.
const ALL_PASS = {
  status: 'PASSED',
  completed: 7,
  total: 7,
  speaker: { status: 'PASSED', left: 'PASSED', right: 'PASSED' },
  keyboard: { status: 'PASSED', deviceType: 'Laptop – Standard' },
  camera: { status: 'PASSED', device: 'HD Webcam' },
  screen: { status: 'PASSED', deadPixels: 0 },
  trackpad: { status: 'PASSED', moved: true, leftClick: true, rightClick: true, scrolled: true },
  microphone: { status: 'PASSED', device: 'Internal Microphone', confirmedBy: 'technician' },
  usb: {
    status: 'PASSED',
    portsSeen: 3,
    devices: [{ port: '1-3', name: 'SanDisk Ultra', speed: 'USB 3.0 (5000 Mbps)' }],
    confirmedBy: 'technician',
  },
};

const ONE_FAILED = {
  ...ALL_PASS,
  status: 'FAILED',
  keyboard: { status: 'FAILED', deviceType: 'Laptop – Standard', reason: 'the Enter key never registered' },
};

// Two faulty components: named in reading order (Speaker, Keyboard, Camera,
// Screen, Trackpad, Microphone, USB ports), so keyboard before screen.
const TWO_FAILED = {
  ...ALL_PASS,
  status: 'FAILED',
  keyboard: { status: 'FAILED', deviceType: 'Laptop – Standard' },
  screen: { status: 'FAILED', deadPixels: 40 },
};

const ONE_ATTENTION = {
  ...ALL_PASS,
  status: 'ATTENTION',
  camera: { status: 'ATTENTION', device: 'HD Webcam', reason: 'picture very dark' },
};

// A run where one component failed AND another only needs attention: FAILED
// beats ATTENTION, so the cell reads "Failed:" and names only the failed one.
const FAILED_BEATS_ATTENTION = {
  ...ALL_PASS,
  status: 'FAILED',
  keyboard: { status: 'FAILED', deviceType: 'Laptop – Standard' },
  camera: { status: 'ATTENTION', device: 'HD Webcam' },
};

// Not finished: no verdict, only how many of seven are done.
const PARTIAL = {
  status: 'IN_PROGRESS',
  completed: 3,
  total: 7,
  speaker: pass,
  keyboard: pass,
  camera: pass,
  screen: { status: 'NOT_TESTED' },
  trackpad: { status: 'NOT_TESTED' },
  microphone: { status: 'NOT_TESTED' },
  usb: { status: 'NOT_TESTED' },
};

// The same, but the station omitted the counts: derive 3 of 7 from the finished
// components rather than inventing a verdict.
const PARTIAL_NO_COUNTS = {
  status: 'IN_PROGRESS',
  speaker: pass,
  keyboard: pass,
  camera: pass,
  screen: { status: 'NOT_TESTED' },
  trackpad: { status: 'IN_PROGRESS' },
  microphone: { status: 'NOT_TESTED' },
  usb: { status: 'NOT_TESTED' },
};

// The two newest tests, each the only thing wrong with the machine. A USB port
// the technician found dead is a FAILED like any other; the cell names it by the
// same label the card uses.
const MIC_ATTENTION = {
  ...ALL_PASS,
  status: 'ATTENTION',
  microphone: {
    status: 'ATTENTION',
    device: 'Internal Microphone',
    reason: 'the microphone permission was refused, so nothing could be listened to',
    action: 'Grant microphone access for this page, then test again.',
  },
};

const USB_FAILED = {
  ...ALL_PASS,
  status: 'FAILED',
  usb: {
    status: 'FAILED',
    portsSeen: 2,
    devices: [{ port: '1-3', name: 'SanDisk Ultra', speed: 'USB 3.0 (5000 Mbps)' }],
    reason: 'the technician reported: the front-left port did nothing',
    confirmedBy: 'technician',
  },
};

// A desktop: the trackpad is benign N/A (stored PASSED with notApplicable), the
// other four pass. It must read "Passed" and must NOT name the trackpad.
const DESKTOP_NA = {
  status: 'PASSED',
  completed: 7,
  total: 7,
  speaker: { status: 'PASSED', left: 'PASSED', right: 'PASSED' },
  keyboard: { status: 'PASSED', deviceType: 'Desktop – Full' },
  camera: { status: 'PASSED', device: 'Logitech C920' },
  screen: { status: 'PASSED', deadPixels: 0 },
  trackpad: { status: 'PASSED', notApplicable: true },
  microphone: { status: 'PASSED', device: 'Logitech C920 Microphone' },
  usb: { status: 'PASSED', portsSeen: 4, devices: [] },
};

describe.each(COPIES)('hardware test one-cell summary (%s copy)', (_name, m) => {
  it('all seven components passed: "Passed"', () => {
    expect(m.hardwareTestSummary(ALL_PASS)).toBe('Passed');
  });

  it('a failed component: "Failed:" names it', () => {
    expect(m.hardwareTestSummary(ONE_FAILED)).toBe('Failed: keyboard');
  });

  it('several failed components: named worst-first, in reading order', () => {
    expect(m.hardwareTestSummary(TWO_FAILED)).toBe('Failed: keyboard, screen');
  });

  it('a component needing attention (nothing failed): "Needs attention:" names it', () => {
    expect(m.hardwareTestSummary(ONE_ATTENTION)).toBe('Needs attention: camera');
  });

  it('FAILED beats ATTENTION: only the failed component is named', () => {
    expect(m.hardwareTestSummary(FAILED_BEATS_ATTENTION)).toBe('Failed: keyboard');
  });

  it('a microphone that could not be tested: "Needs attention:" names it', () => {
    expect(m.hardwareTestSummary(MIC_ATTENTION)).toBe('Needs attention: microphone');
  });

  it('a dead USB port: "Failed:" names it, by the label the card uses', () => {
    expect(m.hardwareTestSummary(USB_FAILED)).toBe('Failed: usb ports');
  });

  it('an unfinished run has no verdict, only "N of 7 tested"', () => {
    expect(m.hardwareTestSummary(PARTIAL)).toBe('3 of 7 tested');
    // Even when the station omitted the counts, count the finished components.
    expect(m.hardwareTestSummary(PARTIAL_NO_COUNTS)).toBe('3 of 7 tested');
  });

  it('a benign N/A trackpad does not count as attention and is never named', () => {
    expect(m.hardwareTestSummary(DESKTOP_NA)).toBe('Passed');
  });

  it('no test on record: a blank cell, like a missing battery', () => {
    for (const t of [null, undefined, 'junk', 42, [], [null], true]) {
      expect(m.hardwareTestSummary(t)).toBe('');
    }
  });

  it('never says "Unknown", for any input here', () => {
    const inputs = [
      ALL_PASS,
      ONE_FAILED,
      TWO_FAILED,
      ONE_ATTENTION,
      FAILED_BEATS_ATTENTION,
      MIC_ATTENTION,
      USB_FAILED,
      PARTIAL,
      PARTIAL_NO_COUNTS,
      DESKTOP_NA,
      { status: 'ATTENTION', camera: { status: 'unknown' } },
      {},
    ];
    for (const t of inputs) {
      expect(m.hardwareTestSummary(t)).not.toMatch(/unknown/i);
    }
  });
});

describe('the API and web copies', () => {
  it('are identical below their headers', () => {
    // Same guard as drive-health.spec: the two files may explain themselves
    // differently up top, but everything from the shared "Rules this file
    // enforces" marker down must be byte-identical, or a drive/test could be
    // worded one way on the card and another in the report.
    const body = (p: string) => {
      const src = readFileSync(p, 'utf8');
      return src.slice(src.indexOf('// Rules this file enforces'));
    };
    const apiSrc = body(join(__dirname, 'hardware-test.ts'));
    expect(apiSrc.length).toBeGreaterThan(1000);
    expect(body(join(__dirname, '../../../web/lib/hardware-test.ts'))).toBe(
      apiSrc,
    );
  });
});
