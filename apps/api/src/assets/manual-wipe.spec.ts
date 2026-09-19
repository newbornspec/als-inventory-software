import { ForbiddenException } from '@nestjs/common';
import {
  assertMayClaimWiped,
  claimsWiped,
  holds,
  lotAttestation,
  mayRecordManualWipe,
  sourceOf,
  wipeAttestation,
} from './manual-wipe';
import type { AuthzSnapshot } from '../auth/permissions.service';
import { UserRole } from '../users/user.entity';

// The rules behind "allow, but labelled": who may hand-record a wipe, how a
// record's provenance is decided, and what its certificate may then claim.

const perms = (s: AuthzSnapshot | null) => ({ getAuthz: jest.fn().mockResolvedValue(s) }) as never;
const snap = (role: UserRole, permissions: string[], disabled = false): AuthzSnapshot => ({
  role,
  permissions,
  disabled,
  passwordChangedAt: null,
});

describe('holds / mayRecordManualWipe', () => {
  it('admin holds everything by role', async () => {
    expect(await mayRecordManualWipe(perms(snap(UserRole.ADMIN, [])), 'u')).toBe(true);
  });
  it('a technician holds it only when granted', async () => {
    expect(await mayRecordManualWipe(perms(snap(UserRole.TECHNICIAN, ['perform_goods_in_audit'])), 'u')).toBe(false);
    expect(await mayRecordManualWipe(perms(snap(UserRole.TECHNICIAN, ['record_manual_wipe'])), 'u')).toBe(true);
  });
  it('a disabled or deleted account holds nothing', async () => {
    expect(await mayRecordManualWipe(perms(snap(UserRole.ADMIN, [], true)), 'u')).toBe(false);
    expect(await mayRecordManualWipe(perms(null), 'u')).toBe(false);
  });
  it('any one of several grants is enough', async () => {
    const p = perms(snap(UserRole.TECHNICIAN, ['perform_amazon_audit']));
    expect(await holds(p, 'u', ['perform_goods_in_audit', 'perform_amazon_audit'])).toBe(true);
  });
});

describe('sourceOf', () => {
  it('a recorded source wins', () => {
    expect(sourceOf({ wipeSource: 'manual', hardwareProfile: { x: 1 } as never })).toBe('manual');
    expect(sourceOf({ wipeSource: 'station', hardwareProfile: null })).toBe('station');
  });
  it('an older row falls back to the migration rule: a profile means the station', () => {
    expect(sourceOf({ wipeSource: null, hardwareProfile: { x: 1 } as never })).toBe('station');
    expect(sourceOf({ wipeSource: null, hardwareProfile: null })).toBe('manual');
  });
});

describe('wipeAttestation', () => {
  it('a manual record never claims the data is unrecoverable', () => {
    const a = wipeAttestation('manual');
    expect(`${a.intro} ${a.result}`).not.toMatch(/unrecoverable/i);
    expect(a.intro).toMatch(/not performed or verified by the ALS audit station/);
    expect(a.result).toMatch(/manually recorded/);
    expect(a.performerLabel).toBe('Recorded by');
    expect(a.dateLabel).toBe('Date recorded');
    expect(a.methodSuffix).toBe(' (manual record)');
  });
  it('a station record keeps the wording certificates have always had', () => {
    const a = wipeAttestation('station');
    expect(a.intro).toMatch(/rendering previously stored data unrecoverable/);
    expect(a.result).toBe('Wiped — data unrecoverable');
    expect(a.performerLabel).toBe('Performed by');
    expect(a.methodSuffix).toBe('');
  });
});

describe('claimsWiped / assertMayClaimWiped - the online routes', () => {
  it('both fields carry the claim', () => {
    expect(claimsWiped({ dataWipeStatus: 'wiped' })).toBe(true);
    expect(claimsWiped({ auditStatus: 'data_wiped' })).toBe(true);
    expect(claimsWiped({ dataWipeStatus: 'failed', auditStatus: 'passed_testing' })).toBe(false);
    expect(claimsWiped({})).toBe(false);
  });
  it('refuses a claim without the grant with a 403, not a 500', async () => {
    const p = perms(snap(UserRole.TECHNICIAN, ['assets', 'goods_in']));
    await expect(assertMayClaimWiped(p, 'u', { auditStatus: 'data_wiped' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('refuses when there is no signed-in user at all', async () => {
    await expect(assertMayClaimWiped(perms(snap(UserRole.ADMIN, [])), undefined, { dataWipeStatus: 'wiped' })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('lets a grantee through, and never looks up anyone for a non-claim', async () => {
    await expect(
      assertMayClaimWiped(perms(snap(UserRole.TECHNICIAN, ['record_manual_wipe'])), 'u', { dataWipeStatus: 'wiped' }),
    ).resolves.toBeUndefined();
    const p = { getAuthz: jest.fn() } as never;
    await expect(assertMayClaimWiped(p, 'u', { conditionGrade: 'grade_a' } as never)).resolves.toBeUndefined();
    expect((p as any).getAuthz).not.toHaveBeenCalled();
  });
});

describe('lotAttestation - a lot can mix station wipes and hand records', () => {
  it('all station: the wording lots have always had', () => {
    const a = lotAttestation(0, 5);
    expect(a.headline).toBe('Devices certified erased: 5');
    expect(a.intro).toMatch(/unrecoverable/);
    expect(a.dateHeader).toBe('Wiped');
  });
  it('all manual: never claims erasure or "unrecoverable"', () => {
    const a = lotAttestation(5, 5);
    expect(`${a.headline} ${a.intro}`).not.toMatch(/unrecoverable|certified erased/i);
    expect(a.intro).toMatch(/entered manually/);
    expect(a.intro).toMatch(/performed or verified by the ALS audit station/);
    expect(a.dateHeader).toBe('Recorded');
  });
  it('mixed: counts both and scopes the claim to the station rows', () => {
    const a = lotAttestation(2, 5);
    expect(a.headline).toMatch(/3 erased by the ALS audit station, 2 recorded manually/);
    expect(a.intro).toMatch(/other than rows marked "\(manual record\)"/);
    expect(a.dateHeader).toBe('Date');
  });

  // Step 39 on the lot certificate (review, wave 2): ANY limitation removes
  // "unrecoverable" for that row - the lead sentence included, not only a
  // later paragraph a reader may never reach.
  it('limitations on some rows: the claim excludes them in the lead sentence', () => {
    const a = lotAttestation(0, 5, 2);
    expect(a.intro).toMatch(
      /^This certifies that the data-storage media in each device listed below, other than rows marked "\(limitations recorded\)", has been sanitised[^.]*unrecoverable/,
    );
    expect(a.intro).toMatch(
      /makes no claim that previously stored data on them cannot be recovered/,
    );
    expect(a.headline).toMatch(/2 with limitations recorded/);
    expect(a.dateHeader).toBe('Wiped');
  });
  it('limitations on every station row: no "unrecoverable" anywhere', () => {
    for (const a of [lotAttestation(0, 3, 3), lotAttestation(2, 5, 3)])
      expect(`${a.headline} ${a.intro}`).not.toMatch(
        /unrecoverable|certified erased/i,
      );
  });
  it('limitations and manual rows together exclude both', () => {
    const a = lotAttestation(1, 5, 1);
    expect(a.intro).toMatch(
      /other than rows marked "\(limitations recorded\)" or "\(manual record\)"/,
    );
    expect(a.intro).toMatch(/entered by hand/);
    expect(a.headline).toMatch(
      /4 erased by the ALS audit station \(1 with limitations recorded\), 1 recorded manually/,
    );
  });
  it('no limitations: the wording is exactly as before', () => {
    for (const [m, t] of [
      [0, 5],
      [5, 5],
      [2, 5],
    ])
      expect(lotAttestation(m, t, 0)).toEqual(lotAttestation(m, t));
  });
});
