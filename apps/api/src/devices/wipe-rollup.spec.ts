import {
  expectedDrivesOf,
  expectedDrivesFromRows,
  refusalFor,
  rollupWipe,
  type RollupRow,
} from './wipe-rollup';
import { MIXED_REFUSAL } from '../assets/certificate-eligibility';
import { DISCARD_REFUSAL } from '../assets/wipe-method';

// Plan step 22 (remediation spec D-6): a machine is wiped only when every
// drive's latest record is a wipe and every internal drive has one.

const MIN = 60 * 1000;
const T0 = new Date('2026-09-19T10:00:00Z').getTime();
const at = (minutes: number) => new Date(T0 + minutes * MIN);

let seq = 0;
// A station record for one drive, wiped at `minutes` and received then too.
const ev = (
  serial: string,
  status: 'wiped' | 'failed',
  minutes: number,
  extra: Partial<RollupRow> = {},
): RollupRow => ({
  id: `r${++seq}`,
  dataWipeStatus: status,
  dataWipeMethod: 'NVMe crypto erase — verified',
  wipedAt: at(minutes),
  createdAt: at(minutes),
  wipeSource: 'station',
  wipedDriveSerial: serial,
  wipedDrive: { serialNumber: serial, model: `Model ${serial}` },
  hardwareProfile: {},
  ...extra,
});

const expect3 = [
  { serialNumber: 'A', model: null },
  { serialNumber: 'B', model: null },
  { serialNumber: 'C', model: null },
];

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

// Every assignment of times to the events AND every array order.
function everyOrdering(
  events: Array<[string, 'wiped' | 'failed']>,
  expected: typeof expect3,
): Set<string> {
  const verdicts = new Set<string>();
  for (const times of permutations(events.map((_, i) => i * 7))) {
    const rows = events.map(([s, st], i) => ev(s, st, times[i]));
    for (const order of permutations(rows))
      verdicts.add(rollupWipe(order, expected).verdict);
  }
  return verdicts;
}

describe('rollupWipe - order never changes the verdict', () => {
  const two = expect3.slice(0, 2);
  const cases: Array<
    [string, Array<[string, 'wiped' | 'failed']>, typeof expect3, string]
  > = [
    [
      '2 drives, both wiped',
      [
        ['A', 'wiped'],
        ['B', 'wiped'],
      ],
      two,
      'wiped',
    ],
    [
      '2 drives, A failed + B wiped',
      [
        ['A', 'failed'],
        ['B', 'wiped'],
      ],
      two,
      'failed',
    ],
    [
      '2 drives, both failed',
      [
        ['A', 'failed'],
        ['B', 'failed'],
      ],
      two,
      'failed',
    ],
    [
      '3 drives, all wiped',
      [
        ['A', 'wiped'],
        ['B', 'wiped'],
        ['C', 'wiped'],
      ],
      expect3,
      'wiped',
    ],
    [
      '3 drives, one failed',
      [
        ['A', 'wiped'],
        ['B', 'failed'],
        ['C', 'wiped'],
      ],
      expect3,
      'failed',
    ],
    [
      '3 drives, two failed',
      [
        ['A', 'failed'],
        ['B', 'failed'],
        ['C', 'wiped'],
      ],
      expect3,
      'failed',
    ],
    [
      '3 listed, 2 wiped records',
      [
        ['A', 'wiped'],
        ['B', 'wiped'],
      ],
      expect3,
      'incomplete',
    ],
    [
      '3 listed, 1 failed of 2 records',
      [
        ['A', 'failed'],
        ['B', 'wiped'],
      ],
      expect3,
      'failed',
    ],
  ];
  for (const [name, events, expected, verdict] of cases) {
    it(name, () => {
      expect([...everyOrdering(events, expected)]).toEqual([verdict]);
    });
  }
});

describe('rollupWipe - the rules', () => {
  it('A failed + B wiped = failed, and names A', () => {
    const r = rollupWipe([ev('A', 'failed', 0), ev('B', 'wiped', 5)]);
    expect(r.verdict).toBe('failed');
    expect(r.drives.find((d) => d.serialNumber === 'A')?.status).toBe('failed');
    expect(refusalFor(r)).toContain('serial A');
  });

  it('A re-wiped after its failure = wiped', () => {
    const r = rollupWipe(
      [ev('A', 'failed', 0), ev('B', 'wiped', 5), ev('A', 'wiped', 30)],
      expect3.slice(0, 2),
    );
    expect(r.verdict).toBe('wiped');
    expect(refusalFor(r)).toBeNull();
  });

  it('a failure AFTER a wipe of the same drive = failed', () => {
    const r = rollupWipe([ev('A', 'wiped', 0), ev('A', 'failed', 30)]);
    expect(r.verdict).toBe('failed');
  });

  it('3 drives listed but 2 records = incomplete, naming the missing one', () => {
    const r = rollupWipe([ev('A', 'wiped', 0), ev('B', 'wiped', 5)], expect3);
    expect(r.verdict).toBe('incomplete');
    expect(r.drives.map((d) => [d.serialNumber, d.status])).toContainEqual([
      'C',
      'missing',
    ]);
    expect(refusalFor(r)).toContain('serial C');
  });

  it('a failure beats a missing drive', () => {
    const r = rollupWipe([ev('A', 'failed', 0)], expect3);
    expect(r.verdict).toBe('failed');
  });

  it('matches serials case-insensitively', () => {
    const r = rollupWipe(
      [ev('abc', 'wiped', 0)],
      [{ serialNumber: 'ABC', model: null }],
    );
    expect(r.verdict).toBe('wiped');
  });

  it('a drive with no serial is keyed by its device path (D18)', () => {
    const noSerial = (dev: string, st: 'wiped' | 'failed', m: number) =>
      ev('', st, m, {
        wipedDriveSerial: null,
        wipedDrive: { devicePath: dev, model: 'Generic' },
      });
    // Two unserialled drives, one failed: failed, not merged into one key.
    expect(
      rollupWipe([
        noSerial('/dev/sda', 'failed', 0),
        noSerial('/dev/sdb', 'wiped', 5),
      ]).verdict,
    ).toBe('failed');
    // Each unserialled listed drive needs its own path-keyed record.
    const listed = [
      { serialNumber: null, model: 'Generic' },
      { serialNumber: null, model: 'Generic' },
    ];
    expect(rollupWipe([noSerial('/dev/sda', 'wiped', 0)], listed).verdict).toBe(
      'incomplete',
    );
    const both = rollupWipe(
      [noSerial('/dev/sda', 'wiped', 0), noSerial('/dev/sdb', 'wiped', 5)],
      listed,
    );
    expect(both.verdict).toBe('wiped');
    expect(both.drives.every((d) => d.serialNumber === null)).toBe(true);
  });

  it('a wrong station clock cannot hide a newer failure of the same drive', () => {
    // Received later, but the station stamped it a year early.
    const r = rollupWipe([
      ev('A', 'wiped', 0),
      ev('A', 'failed', 10, { wipedAt: new Date('2025-01-01T00:00:00Z') }),
    ]);
    expect(r.verdict).toBe('failed');
  });

  it('a TRIM "wipe" is a failed drive, with the discard wording', () => {
    const r = rollupWipe([
      ev('A', 'wiped', 0, { dataWipeMethod: 'Block discard / TRIM (SSD)' }),
    ]);
    expect(r.verdict).toBe('failed');
    expect(r.reason).toBe('discard');
    expect(refusalFor(r)).toBe(DISCARD_REFUSAL);
  });

  it('nothing on record = none', () => {
    expect(rollupWipe([]).verdict).toBe('none');
    expect(
      rollupWipe([{ dataWipeStatus: null, createdAt: at(0) }]).verdict,
    ).toBe('none');
  });
});

describe('rollupWipe - manual records ("allow, but labelled")', () => {
  const manual = (st: 'wiped' | 'failed', m: number): RollupRow => ({
    id: `m${++seq}`,
    dataWipeStatus: st,
    dataWipeMethod: 'Physical destruction',
    createdAt: at(m),
    wipedAt: null,
    wipeSource: 'manual',
    hardwareProfile: null,
  });

  it('a manual wipe newer than every station row covers the machine, labelled manual', () => {
    const r = rollupWipe(
      [ev('A', 'failed', 0), ev('B', 'wiped', 5), manual('wiped', 60)],
      expect3,
    );
    expect(r.verdict).toBe('wiped');
    expect(r.basis).toBe('manual');
    expect(r.drives).toHaveLength(1);
    expect(r.drives[0].manual).toBe(true);
  });

  it('an older manual record is superseded by the station', () => {
    const r = rollupWipe([manual('wiped', 0), ev('A', 'failed', 60)]);
    expect(r.verdict).toBe('failed');
    expect(r.basis).toBe('drives');
  });

  it('with only legacy station rows, a manual wipe is judged by the D11 rule as before', () => {
    const legacyFailed: RollupRow = {
      id: `l${++seq}`,
      dataWipeStatus: 'failed',
      dataWipeMethod: 'NVMe crypto erase',
      createdAt: at(0),
      wipeSource: 'station',
      hardwareProfile: {},
    };
    // Typed an hour after a legacy station failure: refused, as in wave 1.
    const r = rollupWipe([legacyFailed, manual('wiped', 60)]);
    expect(r).toMatchObject({ verdict: 'failed', reason: 'mixed', basis: 'legacy' });
    // Two days later: the failure is history, the manual wipe stands.
    expect(rollupWipe([legacyFailed, manual('wiped', 48 * 60)]).verdict).toBe(
      'wiped',
    );
  });

  it('a manual record alone', () => {
    expect(rollupWipe([manual('wiped', 0)]).verdict).toBe('wiped');
    expect(rollupWipe([manual('failed', 0)]).verdict).toBe('failed');
  });
});

describe('rollupWipe - legacy rows keep the interim rule (D11)', () => {
  const legacy = (st: 'wiped' | 'failed', m: number): RollupRow => ({
    id: `l${++seq}`,
    dataWipeStatus: st,
    dataWipeMethod: 'NVMe crypto erase',
    createdAt: at(m),
    wipeSource: 'station',
    hardwareProfile: {},
  });

  it('legacy wipe alone is certifiable', () => {
    const r = rollupWipe([legacy('wiped', 0)]);
    expect(r).toMatchObject({ verdict: 'wiped', basis: 'legacy' });
    expect(r.drives[0].unidentified).toBe(true);
  });

  it('legacy failure within 24 h before the wipe = mixed', () => {
    const r = rollupWipe([legacy('failed', -60), legacy('wiped', 0)]);
    expect(r).toMatchObject({ verdict: 'failed', reason: 'mixed' });
    expect(refusalFor(r)).toBe(MIXED_REFUSAL);
  });

  it('legacy failure two days before is superseded', () => {
    expect(
      rollupWipe([legacy('failed', -48 * 60), legacy('wiped', 0)]).verdict,
    ).toBe('wiped');
  });

  it('legacy rows older than the first per-drive record are history', () => {
    const r = rollupWipe([legacy('failed', -10), ev('A', 'wiped', 0)]);
    expect(r.verdict).toBe('wiped');
    expect(r.basis).toBe('drives');
  });

  it('a legacy failure filed after the per-drive records makes it worse', () => {
    const r = rollupWipe([ev('A', 'wiped', 0), legacy('failed', 10)]);
    expect(r.verdict).toBe('failed');
  });
});

describe('expectedDrivesOf - the internal drives of the wipe-time profile', () => {
  it('keeps internal drives and drops USB / removable entries', () => {
    expect(
      expectedDrivesOf({
        storage: [
          {
            model: 'Samsung SSD 980',
            serialNumber: 'S1',
            interface: 'NVMe',
            type: 'NVMe',
          },
          {
            model: 'ST1000',
            serialNumber: ' S2 ',
            interface: 'SATA',
            type: 'HDD',
          },
          {
            model: 'SanDisk Ultra',
            serialNumber: 'U1',
            interface: 'usb',
            type: 'SSD',
          },
          { model: 'Card', serialNumber: 'R1', removable: true },
          { model: 'NoSerial', interface: 'SATA' },
          'garbage',
        ],
      }),
    ).toEqual([
      { serialNumber: 'S1', model: 'Samsung SSD 980' },
      { serialNumber: 'S2', model: 'ST1000' },
      { serialNumber: null, model: 'NoSerial' },
    ]);
  });

  it('no profile or no storage lists nothing', () => {
    expect(expectedDrivesOf(null)).toEqual([]);
    expect(expectedDrivesOf({ storage: 'x' })).toEqual([]);
  });

  it('reads the snapshot on the latest per-drive station row', () => {
    const older = ev('A', 'wiped', 0, {
      hardwareProfile: { storage: [{ serialNumber: 'A' }] },
    });
    const newer = ev('B', 'wiped', 5, {
      hardwareProfile: {
        storage: [{ serialNumber: 'A' }, { serialNumber: 'B' }],
      },
    });
    expect(
      expectedDrivesFromRows([newer, older]).map((d) => d.serialNumber),
    ).toEqual(['A', 'B']);
  });
});
