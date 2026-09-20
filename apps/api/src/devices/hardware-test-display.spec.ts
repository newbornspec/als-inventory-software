// The web app's plain-English wording of the technician Hardware Test (contract
// C6). Imported by relative path, exactly as drive-health.spec imports the web
// drive-health copy: the formatter is pure and dependency-free, so the API test
// suite can prove the asset-page card never leaks the stored jargon and never
// invents a verdict, without pulling in React.
import {
  hardwareTestView,
  hardwareTestSummary,
} from '../../../web/lib/hardware-test';

// A real, finished 7-part run, with every field the station actually stores -
// including the jargon (audio mixer command, sink name, missing-key list,
// key counts, colour swatches, raw booleans, USB bus paths) and the history log
// - so the tests can prove none of it reaches a summary.
const FULL = {
  status: 'PASSED',
  completed: 7,
  total: 7,
  technician: 'Stephen',
  testedAt: '2026-09-20T15:50:25Z',
  clockWasNetwork: true,
  speaker: {
    status: 'PASSED',
    left: 'PASSED',
    right: 'PASSED',
    mixer: 'unmuted the default output and set it to 80% (wpctl)',
    sink: 'Built-in Audio Analog Stereo',
    notes: 'working both',
  },
  keyboard: {
    status: 'PASSED',
    deviceType: 'Laptop – Standard',
    layout: 'ANSI',
    detectedKeys: 0,
    expectedKeys: 84,
    missingKeys: ['Esc', 'F1', 'F2', 'F3'],
    confirmedBy: 'technician',
    notes: '',
  },
  camera: {
    status: 'PASSED',
    device: 'Integrated_Webcam_HD: Integrate',
    notes: 'WORKS',
  },
  screen: {
    status: 'PASSED',
    deadPixels: 0,
    coloursShown: ['black', 'white', 'red', 'green', 'blue'],
    notes: '',
  },
  trackpad: {
    status: 'PASSED',
    moved: true,
    leftClick: true,
    rightClick: true,
    scrolled: true,
    confirmedBy: 'technician',
    notes: '',
  },
  microphone: {
    status: 'PASSED',
    device: 'Internal_Microphone_HD: Internal',
    confirmedBy: 'technician',
    notes: '',
  },
  // The USB test's own jargon: bus paths and device strings, which the summary
  // must never print - the count is the whole story a reader needs.
  usb: {
    status: 'PASSED',
    portsSeen: 3,
    devices: [
      { port: '1-3', name: 'SanDisk Ultra', speed: 'USB 3.0 (5000 Mbps)' },
      { port: '1-4', name: 'Logitech USB Receiver', speed: 'USB 2.0 (12 Mbps)' },
      { port: '2-1', name: '', speed: '' },
    ],
    confirmedBy: 'technician',
    notes: '',
  },
  history: [{ test: 'keyboard' }, { test: 'speaker' }],
};

const row = (v: ReturnType<typeof hardwareTestView>, component: string) =>
  v.rows.find((r) => r.component === component)!;

describe('hardware test wording', () => {
  it('a finished 7-part pass: overall Passed, meta, and one clean line per component', () => {
    const v = hardwareTestView(FULL);
    expect(v.present).toBe(true);
    expect(v.overall).toEqual({ label: 'Passed', tone: 'good' });
    expect(v.meta).toBe('Tested by Stephen · 20 Sep 2026');

    // Rows are always in this order.
    expect(v.rows.map((r) => r.component)).toEqual([
      'Speaker',
      'Keyboard',
      'Camera',
      'Screen',
      'Trackpad',
      'Microphone',
      'USB ports',
    ]);

    expect(row(v, 'Speaker')).toEqual({
      component: 'Speaker',
      statusLabel: 'Passed',
      tone: 'good',
      summary: 'Both speakers work — working both',
    });
    // The device type is the useful line; the key counts and missing-key list
    // are dropped.
    expect(row(v, 'Keyboard').summary).toBe('Laptop – Standard');
    // The camera name is tidied and the technician's note kept.
    expect(row(v, 'Camera').summary).toBe('Integrated Webcam HD — WORKS');
    expect(row(v, 'Screen').summary).toBe('No dead pixels');
    expect(row(v, 'Trackpad').summary).toBe('Movement and buttons work');
    // The microphone reads like the camera: the device, tidied the same way.
    expect(row(v, 'Microphone').summary).toBe('Internal Microphone HD');
    // The USB row is a count of ports, never a list of bus paths.
    expect(row(v, 'USB ports').summary).toBe('3 ports responded');

    // The history log is never shown, only quietly counted.
    expect(v.earlierCount).toBe(2);
    expect(hardwareTestSummary(FULL)).toBe('Passed');
  });

  it('the camera device name is tidied: underscores gone, trailing half-word dropped', () => {
    const s = row(hardwareTestView(FULL), 'Camera').summary;
    expect(s).toContain('Integrated Webcam HD');
    expect(s).not.toContain('_');
    expect(s).not.toContain(': Integrate');
    // An empty device name still reads as a sentence, never blank.
    const blank = hardwareTestView({
      status: 'PASSED',
      camera: { status: 'PASSED', device: '', notes: '' },
    });
    expect(row(blank, 'Camera').summary).toBe('the camera');
  });

  it('no raw internal field ever reaches a summary string', () => {
    const v = hardwareTestView(FULL);
    const allText = [
      v.overall.label,
      v.meta,
      ...v.rows.map((r) => r.summary),
    ].join(' || ');
    for (const jargon of [
      'mixer',
      'wpctl',
      'sink',
      'Analog Stereo',
      'missingKeys',
      'detectedKeys',
      'expectedKeys',
      'ANSI',
      'Esc',
      'F1',
      '84',
      'coloursShown',
      'swatch',
      'true',
      'false',
      // The USB test's working detail: a bus path is not a socket, so neither
      // the paths nor the device strings may reach a summary line.
      '1-3',
      '2-1',
      'SanDisk',
      'Logitech',
      'devices',
      'portsSeen',
    ]) {
      expect(allText).not.toContain(jargon);
    }
  });

  it('a screen needing attention makes the overall Needs attention', () => {
    const attn = {
      ...FULL,
      status: 'ATTENTION',
      screen: {
        status: 'ATTENTION',
        deadPixels: 3,
        reason: '3 dead pixels near the centre',
        coloursShown: ['black', 'white'],
        notes: '',
      },
    };
    const v = hardwareTestView(attn);
    expect(v.overall).toEqual({ label: 'Needs attention', tone: 'warn' });
    const screen = row(v, 'Screen');
    expect(screen.statusLabel).toBe('Needs attention');
    expect(screen.tone).toBe('warn');
    // The count-of-dead-pixels line plus the station's plain-English reason.
    expect(screen.summary).toBe('3 dead pixels — 3 dead pixels near the centre');
    // The report cell names the component that needs attention.
    expect(hardwareTestSummary(attn)).toBe('Needs attention: screen');
  });

  it('a failed component makes the overall Failed and the report cell names it', () => {
    const failed = {
      ...FULL,
      status: 'FAILED',
      keyboard: {
        status: 'FAILED',
        deviceType: 'Laptop – Standard',
        detectedKeys: 40,
        expectedKeys: 84,
        missingKeys: ['Enter'],
        reason: 'the Enter key never registered',
        notes: '',
      },
    };
    const v = hardwareTestView(failed);
    expect(v.overall).toEqual({ label: 'Failed', tone: 'bad' });
    expect(row(v, 'Keyboard').summary).toBe(
      'Laptop – Standard — the Enter key never registered',
    );
    expect(hardwareTestSummary(failed)).toBe('Failed: keyboard');
  });

  it('an unfinished run has no verdict, only "3 of 7 tested"', () => {
    const partial = {
      status: 'IN_PROGRESS',
      completed: 3,
      total: 7,
      technician: 'Ann',
      testedAt: '2026-09-20T09:00:00Z',
      clockWasNetwork: true,
      speaker: { status: 'PASSED', left: 'PASSED', right: 'PASSED', notes: '' },
      keyboard: { status: 'PASSED', deviceType: 'Laptop – Standard', notes: '' },
      camera: { status: 'PASSED', device: 'HD Webcam', notes: '' },
      screen: { status: 'NOT_TESTED' },
      trackpad: { status: 'NOT_TESTED' },
      microphone: { status: 'NOT_TESTED' },
      usb: { status: 'NOT_TESTED' },
      history: [],
    };
    const v = hardwareTestView(partial);
    expect(v.overall).toEqual({ label: '3 of 7 tested', tone: 'neutral' });
    // No verdict word anywhere in the headline.
    expect(v.overall.label).not.toMatch(/passed|failed|needs attention/i);
    // An untested component reads "Not tested", never "Unknown".
    expect(row(v, 'Screen').statusLabel).toBe('Not tested');
    expect(row(v, 'Screen').tone).toBe('neutral');
    // ...and so do the two newest ones, with nothing to say about them.
    expect(row(v, 'Microphone').statusLabel).toBe('Not tested');
    expect(row(v, 'USB ports').statusLabel).toBe('Not tested');
    expect(row(v, 'USB ports').summary).toBe('');
    expect(hardwareTestSummary(partial)).toBe('3 of 7 tested');
  });

  it('a missing completed/total is counted from the finished components', () => {
    // Same partial, but the station omitted the counts: derive 3 of 7 anyway.
    const v = hardwareTestView({
      status: 'IN_PROGRESS',
      speaker: { status: 'PASSED', left: 'PASSED', right: 'PASSED' },
      keyboard: { status: 'PASSED', deviceType: 'Laptop – Standard' },
      camera: { status: 'PASSED', device: 'HD Webcam' },
      screen: { status: 'NOT_TESTED' },
      trackpad: { status: 'IN_PROGRESS' },
      microphone: { status: 'NOT_TESTED' },
      usb: { status: 'NOT_TESTED' },
    });
    expect(v.overall).toEqual({ label: '3 of 7 tested', tone: 'neutral' });
  });

  it('the microphone and USB ports read in plain English, and never auto-fail', () => {
    // A station that could not run either test: needs attention with a reason
    // and an action - never "Failed", and never "Unknown".
    const couldNotRun = hardwareTestView({
      status: 'ATTENTION',
      microphone: {
        status: 'ATTENTION',
        device: 'the microphone',
        reason: 'no microphone is fitted to this machine',
        action: 'None if this model has no microphone.',
        notes: '',
      },
      usb: {
        status: 'ATTENTION',
        portsSeen: 0,
        devices: [],
        reason: "this station cannot read the machine's USB ports",
        notes: '',
      },
    });
    const mic = row(couldNotRun, 'Microphone');
    expect(mic.statusLabel).toBe('Needs attention');
    expect(mic.tone).toBe('warn');
    expect(mic.summary).toBe(
      'the microphone — no microphone is fitted to this machine',
    );
    const usb = row(couldNotRun, 'USB ports');
    expect(usb.statusLabel).toBe('Needs attention');
    expect(usb.summary).toBe(
      "0 ports responded — this station cannot read the machine's USB ports",
    );
    // Nothing plugged in is a count of nought, not a fault: the row says so in
    // words and the verdict is still whatever the technician gave it.
    const nonePlugged = hardwareTestView({
      status: 'PASSED',
      usb: { status: 'PASSED', portsSeen: 0, devices: [], notes: '' },
    });
    expect(row(nonePlugged, 'USB ports').statusLabel).toBe('Passed');
    expect(row(nonePlugged, 'USB ports').summary).toBe('0 ports responded');
    // One port reads as one, not "1 ports".
    const one = hardwareTestView({
      status: 'PASSED',
      usb: { status: 'PASSED', portsSeen: 1, devices: [] },
    });
    expect(row(one, 'USB ports').summary).toBe('1 port responded');
  });

  it('a machine with no trackpad reads neutral N/A and does not drag the overall down', () => {
    const desktop = {
      status: 'PASSED',
      completed: 7,
      total: 7,
      technician: 'Stephen',
      testedAt: '2026-09-20T15:50:25Z',
      clockWasNetwork: true,
      speaker: { status: 'PASSED', left: 'PASSED', right: 'PASSED', notes: '' },
      keyboard: { status: 'PASSED', deviceType: 'Desktop – Full', notes: '' },
      camera: { status: 'PASSED', device: 'Logitech C920', notes: '' },
      screen: { status: 'PASSED', deadPixels: 0, notes: '' },
      trackpad: { status: 'PASSED', notApplicable: true, notes: '' },
      microphone: { status: 'PASSED', device: 'Logitech C920 Microphone', notes: '' },
      usb: { status: 'PASSED', portsSeen: 4, devices: [], notes: '' },
      history: [],
    };
    const v = hardwareTestView(desktop);
    const tp = row(v, 'Trackpad');
    expect(tp.statusLabel).toBe('N/A');
    expect(tp.tone).toBe('neutral');
    expect(tp.summary).toBe('No trackpad fitted');
    // The benign N/A does not become a green "Passed" and does not worsen the run.
    expect(tp.tone).not.toBe('good');
    expect(v.overall).toEqual({ label: 'Passed', tone: 'good' });
    expect(hardwareTestSummary(desktop)).toBe('Passed');
  });

  it('a faulty channel or a lost button is named in words, never a raw boolean', () => {
    const v = hardwareTestView({
      status: 'ATTENTION',
      speaker: {
        status: 'ATTENTION',
        left: 'PASSED',
        right: 'FAILED',
        reason: 'no sound from the right channel',
        notes: '',
      },
      trackpad: {
        status: 'ATTENTION',
        moved: true,
        leftClick: false,
        rightClick: true,
        scrolled: true,
        reason: 'the left button did not register',
        notes: '',
      },
    });
    expect(row(v, 'Speaker').summary).toBe(
      'Left works, right faulty — no sound from the right channel',
    );
    expect(row(v, 'Trackpad').summary).toBe(
      'Left button not detected — the left button did not register',
    );
  });

  it('the clock caveat is added only when the station admits its clock was loose', () => {
    const v = hardwareTestView({ ...FULL, clockWasNetwork: false });
    expect(v.meta).toBe(
      'Tested by Stephen · 20 Sep 2026 · clock not network-synced',
    );
  });

  it('never says "Unknown", for any of these inputs', () => {
    const inputs: unknown[] = [
      FULL,
      {},
      { status: 'unknown' },
      {
        status: 'PASSED',
        camera: { status: 'PASSED', device: 'unknown' },
        speaker: { status: 'PASSED', left: 'unknown', right: 'unknown' },
        keyboard: { status: 'PASSED', deviceType: 'unknown' },
      },
    ];
    for (const i of inputs) {
      const v = hardwareTestView(i);
      const text = [
        v.overall.label,
        v.meta,
        ...v.rows.flatMap((r) => [r.component, r.statusLabel, r.summary]),
      ].join(' | ');
      expect(text).not.toMatch(/unknown/i);
      expect(hardwareTestSummary(i)).not.toMatch(/unknown/i);
    }
  });

  it('a null, empty or garbage test degrades without throwing', () => {
    for (const bad of [null, undefined, '', 'junk', 42, [], [1, 2], NaN]) {
      expect(() => hardwareTestView(bad)).not.toThrow();
      expect(() => hardwareTestSummary(bad)).not.toThrow();
      const v = hardwareTestView(bad);
      expect(v.present).toBe(false);
      expect(v.rows).toEqual([]);
      expect(hardwareTestSummary(bad)).toBe('');
    }
    // An object is "present" even when empty, and still never throws or invents.
    const empty = hardwareTestView({});
    expect(empty.present).toBe(true);
    expect(empty.overall).toEqual({ label: '0 of 7 tested', tone: 'neutral' });
    expect(empty.rows.every((r) => r.statusLabel === 'Not tested')).toBe(true);
  });
});
