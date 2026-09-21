import { ValidationPipe } from '@nestjs/common';
import { DataWipeStatus } from '../assets/asset-audit.entity';
import { IngestAuditDto } from './dto/ingest-audit.dto';
import type { HardwareProfile } from './hardware-profile.type';
import { ingestHarness } from './ingest-harness-for-spec';
import {
  lockStatusOf,
  normaliseWipeDetail,
  wipeDetailNote,
} from './wipe-detail';

// Remediation spec steps 19, 26, 39 (storage): the per-drive wipe detail a
// station sends, and the rule that a bad value in one of these NEW fields is
// stored as NULL with a note - never a 400, which the stick retries forever.

const NOW = new Date('2026-09-19T10:05:00Z');

const FULL = {
  wipedAt: '2026-09-19T10:01:07Z',
  wipeStartedAt: '2026-09-19T10:00:00Z',
  wipedAtClock: 'network',
  wipedDrive: {
    serialNumber: 'S5H2NS0N123456',
    model: 'Samsung SSD 980',
    sizeBytes: 512110190592,
    transport: 'nvme',
    rotational: false,
    wwn: 'eui.0025385b71b0a1c2',
    devicePath: '/dev/nvme0n1',
  },
  toolName: 'als-audit-station',
  toolVersion: '2026.09.19',
  toolCommit: '7eda9ea-dirty',
  methodRequested: 'auto',
  methodAttempted: 'nvme-sanitize-crypto',
  fallbackReason: '',
  sanitisationLevel: 'purge',
  verification: 'clean',
  hiddenAreas: 'none',
  wipeLimitations: ['Over-provisioned area not addressable'],
  wipeSmart: {
    reallocatedBefore: 0,
    pendingBefore: 0,
    reallocatedAfter: 0,
    pendingAfter: 0,
  },
};

const PROFILE: HardwareProfile = {
  identification: {
    manufacturer: 'Dell',
    model: 'Latitude 7490',
    serialNumber: 'ABC1234',
  },
  locks: { status: 'LOCKED', checks: [] },
  security: { lockStatus: 'LOCKED' },
};

describe('normaliseWipeDetail', () => {
  it('keeps every well-formed field', () => {
    const { detail, notes } = normaliseWipeDetail(FULL, NOW);
    expect(notes).toEqual([]);
    expect(detail).toEqual({
      wipedAt: new Date('2026-09-19T10:01:07Z'),
      wipeStartedAt: new Date('2026-09-19T10:00:00Z'),
      wipedAtClock: 'network',
      wipedDriveSerial: 'S5H2NS0N123456',
      wipedDrive: FULL.wipedDrive,
      toolName: 'als-audit-station',
      toolVersion: '2026.09.19',
      toolCommit: '7eda9ea-dirty',
      wipeMethodRequested: 'auto',
      wipeMethodAttempted: 'nvme-sanitize-crypto',
      wipeFallbackReason: null,
      sanitisationLevel: 'purge',
      wipeVerification: 'clean',
      hiddenAreas: 'none',
      wipeLimitations: ['Over-provisioned area not addressable'],
      wipeSmart: FULL.wipeSmart,
    });
  });

  it('an old payload with none of the fields stores all NULL, no notes', () => {
    const { detail, notes } = normaliseWipeDetail({}, NOW);
    expect(notes).toEqual([]);
    expect(Object.values(detail).every((v) => v === null)).toBe(true);
  });

  it('a wipedAt more than 5 minutes ahead is NULL with a note', () => {
    const { detail, notes } = normaliseWipeDetail(
      { wipedAt: '2027-01-01T00:00:00Z' },
      NOW,
    );
    expect(detail.wipedAt).toBeNull();
    expect(notes.join()).toMatch(/wipedAt .* in the future/);
  });

  it('a wipedAt a few minutes ahead (clock skew) is kept', () => {
    const { detail } = normaliseWipeDetail(
      { wipedAt: '2026-09-19T10:09:00Z' },
      NOW,
    );
    expect(detail.wipedAt).toEqual(new Date('2026-09-19T10:09:00Z'));
  });

  it('a date that is not ISO-8601 is NULL with a note', () => {
    for (const bad of ['7', 'Sept 19', 'not a date', 12345, {}]) {
      const { detail, notes } = normaliseWipeDetail({ wipedAt: bad }, NOW);
      expect(detail.wipedAt).toBeNull();
      expect(notes).toHaveLength(1);
    }
  });

  it('an unknown enum value is NULL with a note naming it', () => {
    const { detail, notes } = normaliseWipeDetail(
      {
        sanitisationLevel: 'destroy',
        verification: 'maybe',
        hiddenAreas: 'lots',
        wipedAtClock: 'gps',
        methodRequested: 'magnet',
      },
      NOW,
    );
    expect(detail.sanitisationLevel).toBeNull();
    expect(detail.wipeVerification).toBeNull();
    expect(detail.hiddenAreas).toBeNull();
    expect(detail.wipedAtClock).toBeNull();
    expect(detail.wipeMethodRequested).toBeNull();
    expect(notes).toHaveLength(5);
    expect(notes.join()).toContain('sanitisationLevel destroy');
  });

  it('truncates oversize strings to their columns', () => {
    const { detail, notes } = normaliseWipeDetail(
      {
        toolVersion: 'v'.repeat(500),
        methodAttempted: 'm'.repeat(1000),
        wipedDrive: { serialNumber: 'S'.repeat(300) },
      },
      NOW,
    );
    expect(detail.toolVersion).toHaveLength(64);
    expect(detail.wipeMethodAttempted).toHaveLength(255);
    expect(detail.wipedDriveSerial).toHaveLength(128);
    expect(notes).toEqual([]);
  });

  it('a value of the wrong type is NULL with a note', () => {
    const { detail, notes } = normaliseWipeDetail(
      {
        toolVersion: 7,
        wipedDrive: 'nvme0n1',
        wipeLimitations: 'none',
        wipeSmart: [1, 2],
      },
      NOW,
    );
    expect(detail.toolVersion).toBeNull();
    expect(detail.wipedDrive).toBeNull();
    expect(detail.wipeLimitations).toBeNull();
    expect(detail.wipeSmart).toBeNull();
    expect(notes).toHaveLength(4);
  });

  it('keeps only known drive and SMART keys, and only sane numbers', () => {
    const { detail } = normaliseWipeDetail(
      {
        wipedDrive: {
          serialNumber: '  X1  ',
          sizeBytes: -5,
          rotational: 'yes',
          extra: 'x'.repeat(10000),
        },
        wipeSmart: { reallocatedBefore: 3, pendingAfter: 1.5, junk: 9 },
      },
      NOW,
    );
    expect(detail.wipedDrive).toEqual({ serialNumber: 'X1' });
    expect(detail.wipedDriveSerial).toBe('X1');
    expect(detail.wipeSmart).toEqual({ reallocatedBefore: 3 });
  });

  it('an empty limitations list is kept as [] (reported none), not NULL', () => {
    expect(
      normaliseWipeDetail({ wipeLimitations: [] }, NOW).detail.wipeLimitations,
    ).toEqual([]);
  });

  // Every entry dropped here is a qualification the station put on the wipe,
  // and the certificate prints an empty list as "None reported" - a statement
  // that there was nothing to qualify, made out of values we threw away.
  describe('limitations that could not be read', () => {
    it('never turns entries it discarded into "no limitations"', () => {
      const { detail } = normaliseWipeDetail(
        { wipeLimitations: [{ text: 'HPA present' }, 42, null] },
        NOW,
      );
      expect(detail.wipeLimitations).not.toEqual([]);
      expect(detail.wipeLimitations).toHaveLength(1);
      expect(detail.wipeLimitations?.[0]).toContain('could not be read');
      expect(detail.wipeLimitations?.[0]).toContain('3 limitations');
    });

    it('keeps the ones it could read alongside the count it could not', () => {
      const { detail, notes } = normaliseWipeDetail(
        { wipeLimitations: ['Over-provisioned area not addressable', 7] },
        NOW,
      );
      expect(detail.wipeLimitations).toEqual([
        'Over-provisioned area not addressable',
        '1 limitation recorded by the station could not be read and is not listed here',
      ]);
      expect(notes).toEqual([
        '1 of 2 wipeLimitations entries were not text',
      ]);
    });

    it('says so rather than silently cutting the list at the cap', () => {
      const many = Array.from({ length: 60 }, (_, i) => `limitation ${i}`);
      const { detail } = normaliseWipeDetail({ wipeLimitations: many }, NOW);
      expect(detail.wipeLimitations).toHaveLength(50);
      expect(detail.wipeLimitations?.[49]).toBe(
        '10 further limitations recorded by the station are not listed here',
      );
      // The cap is still a cap: the note is inside it, not on top of it.
      expect(detail.wipeLimitations?.length).toBeLessThanOrEqual(50);
    });

    it('leaves a clean list exactly as it was', () => {
      const { detail, notes } = normaliseWipeDetail(
        { wipeLimitations: ['  HPA present  ', 'DCO present'] },
        NOW,
      );
      expect(detail.wipeLimitations).toEqual(['HPA present', 'DCO present']);
      expect(notes).toEqual([]);
    });
  });
});

describe('wipeDetailNote', () => {
  it('says nothing when nothing was set aside', () => {
    expect(wipeDetailNote([])).toBeNull();
  });
  it('names what was set aside', () => {
    expect(wipeDetailNote(['a', 'b'])).toBe(
      '[Station record: a; b. Stored as not recorded.]',
    );
  });
});

describe('lockStatusOf', () => {
  it('reads the lock roll-up the engine writes', () => {
    expect(lockStatusOf({ locks: { status: 'LOCKED' } })).toBe('LOCKED');
    expect(lockStatusOf({ locks: { status: 'CLEAR' } })).toBe('CLEAR');
  });
  it('falls back to security.lockStatus (the detectors did not run)', () => {
    expect(lockStatusOf({ security: { lockStatus: 'UNVERIFIED' } })).toBe(
      'UNVERIFIED',
    );
  });
  it('knows only the four roll-up values', () => {
    expect(lockStatusOf({ locks: { status: 'bogus' as never } })).toBeNull();
    expect(lockStatusOf({ security: { lockStatus: 'warning' } })).toBe(
      'WARNING',
    );
    expect(lockStatusOf({})).toBeNull();
    expect(lockStatusOf(null)).toBeNull();
  });
});

describe('ingest stores the wipe detail', () => {
  const payload = (over: Record<string, unknown> = {}) =>
    ({
      profile: PROFILE,
      dataWipeStatus: DataWipeStatus.WIPED,
      dataWipeMethod: 'NVMe crypto erase — verified (reads as random)',
      ...over,
    }) as IngestAuditDto;

  it('a payload with the new fields persists them', async () => {
    const { svc, audits } = ingestHarness();
    // Past times, so the test does not depend on today's date.
    await svc.ingest(
      'u1',
      payload({
        ...FULL,
        wipeStartedAt: '2026-01-02T03:00:00Z',
        wipedAt: '2026-01-02T03:04:05Z',
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      wipedAt: new Date('2026-01-02T03:04:05Z'),
      wipeStartedAt: new Date('2026-01-02T03:00:00Z'),
      wipedAtClock: 'network',
      wipedDriveSerial: 'S5H2NS0N123456',
      wipedDrive: FULL.wipedDrive,
      toolName: 'als-audit-station',
      toolVersion: '2026.09.19',
      toolCommit: '7eda9ea-dirty',
      wipeMethodRequested: 'auto',
      wipeMethodAttempted: 'nvme-sanitize-crypto',
      sanitisationLevel: 'purge',
      wipeVerification: 'clean',
      hiddenAreas: 'none',
      wipeLimitations: FULL.wipeLimitations,
      wipeSmart: FULL.wipeSmart,
      lockStatus: 'LOCKED',
      notes: null,
    });
  });

  it('an old payload without them still succeeds, with the lock status derived', async () => {
    const { svc, audits } = ingestHarness();
    await expect(svc.ingest('u1', payload())).resolves.toMatchObject({
      created: true,
    });
    expect(audits[0]).toMatchObject({
      wipedAt: null,
      wipedDriveSerial: null,
      toolVersion: null,
      sanitisationLevel: null,
      lockStatus: 'LOCKED',
      notes: null,
    });
  });

  it('a future wipedAt is stored NULL with a note, and the record still files', async () => {
    const { svc, audits } = ingestHarness();
    await svc.ingest(
      'u1',
      payload({ wipedAt: '2999-01-01T00:00:00Z', notes: 'Bay 3' }),
    );
    expect(audits[0].wipedAt).toBeNull();
    expect(audits[0].notes).toMatch(
      /^Bay 3\n\[Station record: wipedAt .*future/,
    );
  });

  it('an invalid sanitisationLevel is stored NULL, not rejected', async () => {
    const { svc, audits } = ingestHarness();
    await svc.ingest('u1', payload({ sanitisationLevel: 'obliterate' }));
    expect(audits[0].sanitisationLevel).toBeNull();
    expect(audits[0].notes).toContain('sanitisationLevel obliterate');
  });
});

describe('the ingest DTO admits the new fields without judging them', () => {
  // The same pipe main.ts installs globally.
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const run = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: IngestAuditDto });

  it('keeps every C2 field past the whitelist', async () => {
    const out = (await run({ ...FULL })) as Record<string, unknown>;
    for (const k of Object.keys(FULL))
      expect(out[k]).toEqual(FULL[k as keyof typeof FULL]);
  });

  it('never answers 400 for a bad value in a new field', async () => {
    await expect(
      run({
        wipedAt: 'yesterday',
        sanitisationLevel: 'obliterate',
        wipedDrive: 42,
        wipeLimitations: { a: 1 },
        wipeSmart: 'n/a',
        toolVersion: ['x'],
      }),
    ).resolves.toBeDefined();
  });

  it('still refuses a bad value in an existing validated field', async () => {
    await expect(run({ dataWipeStatus: 'sort-of' })).rejects.toThrow();
  });
});
