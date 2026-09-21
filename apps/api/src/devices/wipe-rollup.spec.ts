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

  it('drives with no serial (D18): one record per listed drive', () => {
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
    // Each unserialled listed drive needs its own record.
    const listed = [
      { serialNumber: null, model: 'Generic' },
      { serialNumber: null, model: 'Generic' },
    ];
    expect(rollupWipe([noSerial('/dev/sda', 'wiped', 0)], listed).verdict).toBe(
      'incomplete',
    );
    // Two identical unserialled drives: two device paths do not prove two
    // drives (device names move between boots), so without a WWN the
    // records cannot show both were wiped (review, wave 2).
    expect(
      rollupWipe(
        [noSerial('/dev/sda', 'wiped', 0), noSerial('/dev/sdb', 'wiped', 5)],
        listed,
      ).verdict,
    ).toBe('incomplete');
    // With a WWN on every record, each drive is told apart.
    const withWwn = (dev: string, wwn: string, m: number) =>
      ev('', 'wiped', m, {
        wipedDriveSerial: null,
        wipedDrive: { devicePath: dev, model: 'Generic', wwn },
      });
    const both = rollupWipe(
      [withWwn('/dev/sda', 'wwn-1', 0), withWwn('/dev/sdb', 'wwn-2', 5)],
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
    expect(r).toMatchObject({
      verdict: 'failed',
      reason: 'mixed',
      basis: 'legacy',
    });
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
    // WITH the expectation, as production always passes it: a verdict of
    // "wiped" now means "and we knew which drives there were", so a fixture
    // that omits it is asserting something the certificate route never does.
    const r = rollupWipe(
      [legacy('failed', -10), ev('A', 'wiped', 0)],
      [{ serialNumber: 'A', model: null }],
    );
    expect(r.verdict).toBe('wiped');
    expect(r.basis).toBe('drives');
  });

  it('a wipe with no drive list behind it cannot be certified', () => {
    // The certificate gate's own hole: `missing` outcomes are the only thing
    // that produces 'incomplete', and they can only come from the expectation.
    // An empty one therefore rolled up exactly like a fully accounted machine.
    const r = rollupWipe([ev('A', 'wiped', 0)]);
    expect(r.verdict).toBe('incomplete');
    expect(r.reason).toBe('unverifiable');
    expect(refusalFor(r)).toMatch(/never recorded which drives/i);
  });

  it('but a drive list we DID read and found nothing external in still certifies', () => {
    const r = rollupWipe(
      [ev('A', 'wiped', 0, { hardwareProfile: { storage: [{ serialNumber: 'A' }] } })],
      [{ serialNumber: 'A', model: null }],
    );
    expect(r.verdict).toBe('wiped');
  });

  it('a legacy failure filed after the per-drive records makes it worse', () => {
    const r = rollupWipe([ev('A', 'wiped', 0), legacy('failed', 10)]);
    expect(r.verdict).toBe('failed');
  });
});

// Review findings, wave 2 round A: drive identity that a serial or a device
// path alone does not settle.
describe('rollupWipe - drives the records cannot tell apart', () => {
  const GB = 1e9;
  // A station record carrying its own wipe-time profile, as every per-drive
  // record does.
  const rec = (
    status: 'wiped' | 'failed',
    minutes: number,
    drive: {
      serial?: string;
      model: string;
      path: string;
      gb?: number;
      wwn?: string;
    },
    storage: unknown[],
  ): RollupRow =>
    ev(drive.serial ?? '', status, minutes, {
      wipedDriveSerial: drive.serial ?? null,
      wipedDrive: {
        ...(drive.serial ? { serialNumber: drive.serial } : {}),
        model: drive.model,
        devicePath: drive.path,
        sizeBytes: (drive.gb ?? 512) * GB,
        ...(drive.wwn ? { wwn: drive.wwn } : {}),
      },
      hardwareProfile: { storage },
    });
  const verdictOf = (rows: RollupRow[]) =>
    rollupWipe(rows, expectedDrivesFromRows(rows)).verdict;
  const entry = (model: string, serial?: string, gb = 512) => ({
    model,
    capacity: `${gb}GB`,
    interface: 'SATA',
    ...(serial ? { serialNumber: serial } : {}),
  });

  describe('two drives reporting the same serial', () => {
    const dup = [
      entry('Cheap SSD', '0000000000'),
      entry('Cheap SSD', '0000000000'),
    ];
    const d = (path: string, wwn?: string) => ({
      serial: '0000000000',
      model: 'Cheap SSD',
      path,
      wwn,
    });

    it('a failure on one is not hidden by a later wipe of the other', () => {
      for (const order of permutations([
        rec('failed', 0, d('/dev/sda'), dup),
        rec('wiped', 5, d('/dev/sdb'), dup),
      ]))
        expect(verdictOf(order)).toBe('failed');
    });

    it('one wipe record does not cover both listed drives', () => {
      expect(verdictOf([rec('wiped', 0, d('/dev/sda'), dup)])).toBe(
        'incomplete',
      );
    });

    it('two wipes at two paths without a WWN cannot prove both drives', () => {
      const r = rollupWipe(
        [
          rec('wiped', 0, d('/dev/sda'), dup),
          rec('wiped', 5, d('/dev/sdb'), dup),
        ],
        expectedDrivesFromRows([rec('wiped', 0, d('/dev/sda'), dup)]),
      );
      expect(r.verdict).toBe('incomplete');
      expect(refusalFor(r)).toContain('cannot be told apart');
    });

    it('with a WWN on every record, each drive is its own', () => {
      expect(
        verdictOf([
          rec('wiped', 0, d('/dev/sda', 'wwn-1'), dup),
          rec('wiped', 5, d('/dev/sdb', 'wwn-2'), dup),
        ]),
      ).toBe('wiped');
      expect(
        verdictOf([
          rec('failed', 0, d('/dev/sda', 'wwn-1'), dup),
          rec('wiped', 5, d('/dev/sdb', 'wwn-2'), dup),
        ]),
      ).toBe('failed');
      // The failed drive re-wiped - at another path after a reboot.
      expect(
        verdictOf([
          rec('failed', 0, d('/dev/sda', 'wwn-1'), dup),
          rec('wiped', 5, d('/dev/sdb', 'wwn-2'), dup),
          rec('wiped', 60, d('/dev/sdb', 'wwn-1'), dup),
          rec('wiped', 61, d('/dev/sda', 'wwn-2'), dup),
        ]),
      ).toBe('wiped');
    });

    it('a serial listed once whose records show two different models', () => {
      // A second drive with the same serial the profile never saw.
      const one = [entry('Cheap SSD', '0000000000')];
      expect(
        verdictOf([
          rec('failed', 0, { ...d('/dev/sda'), model: 'Other SSD' }, one),
          rec('wiped', 5, d('/dev/sdb'), one),
        ]),
      ).toBe('failed');
    });
  });

  describe('drives with no serial (D18) and moving device paths', () => {
    it('the same drive at two paths does not stand in for a second drive', () => {
      // X wiped at sda; after a reboot X is sdb and is wiped again; Y never.
      const same = [entry('Generic'), entry('Generic')];
      const X = { model: 'Generic' };
      expect(
        verdictOf([
          rec('wiped', 0, { ...X, path: '/dev/sda' }, same),
          rec('wiped', 60, { ...X, path: '/dev/sdb' }, same),
        ]),
      ).toBe('incomplete');
      // Different models: X's records cannot cover Y.
      const xy = [entry('Model X'), entry('Model Y')];
      expect(
        verdictOf([
          rec('wiped', 0, { model: 'Model X', path: '/dev/sda' }, xy),
          rec('wiped', 60, { model: 'Model X', path: '/dev/sdb' }, xy),
        ]),
      ).toBe('incomplete');
    });

    it("a path swap does not let Y's re-wipe hide X's failure", () => {
      const xy = [entry('Model X'), entry('Model Y')];
      const rows = [
        rec('failed', 0, { model: 'Model X', path: '/dev/sda' }, xy),
        rec('wiped', 5, { model: 'Model Y', path: '/dev/sdb' }, xy),
        rec('wiped', 60, { model: 'Model Y', path: '/dev/sda' }, xy),
      ];
      for (const order of permutations(rows))
        expect(verdictOf(order)).toBe('failed');
      // Identical models: still never 'wiped'.
      const same = [entry('Generic'), entry('Generic')];
      expect(
        verdictOf([
          rec('failed', 0, { model: 'Generic', path: '/dev/sda' }, same),
          rec('wiped', 5, { model: 'Generic', path: '/dev/sdb' }, same),
          rec('wiped', 60, { model: 'Generic', path: '/dev/sda' }, same),
        ]),
      ).not.toBe('wiped');
    });

    it('a hot-plugged unserialled drive does not cover the internal one', () => {
      const listed = [entry('Internal')];
      expect(
        verdictOf([
          rec('wiped', 0, { model: 'Stray', path: '/dev/sdc' }, listed),
        ]),
      ).toBe('incomplete');
    });

    it('the one unserialled drive, failed then re-wiped at another path = wiped', () => {
      const listed = [entry('Generic')];
      expect(
        verdictOf([
          rec('failed', 0, { model: 'Generic', path: '/dev/sda' }, listed),
          rec('wiped', 60, { model: 'Generic', path: '/dev/sdb' }, listed),
        ]),
      ).toBe('wiped');
    });
  });

  describe('a drive a later profile no longer lists', () => {
    it('stays expected until it has a record', () => {
      const s1 = [entry('A', 'A'), entry('B', 'B')];
      const s2 = [entry('A', 'A')]; // B dropped off the bus
      const first = rec(
        'wiped',
        0,
        { serial: 'A', model: 'A', path: '/dev/sda' },
        s1,
      );
      expect(verdictOf([first])).toBe('incomplete');
      const again = rec(
        'wiped',
        60,
        { serial: 'A', model: 'A', path: '/dev/sda' },
        s2,
      );
      const r = rollupWipe(
        [first, again],
        expectedDrivesFromRows([first, again]),
      );
      expect(r.verdict).toBe('incomplete');
      expect(refusalFor(r)).toContain('serial B');
    });
  });

  it('an eMMC machine whose boot partitions share its serial can be wiped', () => {
    const emmc = [
      { serialNumber: '0x1234', capacity: '64GB', interface: 'mmc' },
      { serialNumber: '0x1234', capacity: '0GB', interface: 'mmc' },
      { serialNumber: '0x1234', capacity: '0GB', interface: 'mmc' },
      { capacity: '8GB', type: 'SSD' }, // zram
    ];
    expect(
      verdictOf([
        rec(
          'wiped',
          0,
          { serial: '0x1234', model: '', path: '/dev/mmcblk0', gb: 64 },
          emmc,
        ),
      ]),
    ).toBe('wiped');
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
      { serialNumber: 'S1', model: 'Samsung SSD 980', capacityGB: null },
      { serialNumber: 'S2', model: 'ST1000', capacityGB: null },
      { serialNumber: null, model: 'NoSerial', capacityGB: null },
    ]);
  });

  it('no profile or no storage lists nothing', () => {
    expect(expectedDrivesOf(null)).toEqual([]);
    expect(expectedDrivesOf({ storage: 'x' })).toEqual([]);
  });

  it('drops pseudo-devices and eMMC hardware boot partitions (review, wave 2)', () => {
    // zram swap in the live session: TYPE=disk, no model, no serial, no bus.
    // mmcblk0boot0/1: 4 MB, the parent's serial - "0GB" in the profile.
    expect(
      expectedDrivesOf({
        storage: [
          { capacity: '8GB', type: 'SSD' },
          {
            model: '',
            serialNumber: '0x1234',
            capacity: '64GB',
            interface: 'mmc',
          },
          { serialNumber: '0x1234', capacity: '0GB', interface: 'mmc' },
          { serialNumber: '0x1234', capacity: '0GB', interface: 'mmc' },
        ],
      }),
    ).toEqual([{ serialNumber: '0x1234', model: null, capacityGB: 64 }]);
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
