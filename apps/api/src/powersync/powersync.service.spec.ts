import { PowerSyncService, acceptableCreatedAt } from './powersync.service';
import type { AuthzSnapshot } from '../auth/permissions.service';
import { UserRole } from '../users/user.entity';
import { Asset } from '../assets/asset.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import { AssetAudit } from '../assets/asset-audit.entity';

// The offline-sync upload used to apply whatever a client sent to any row of
// assets, asset_audits and asset_history - so any signed-in account, the audit
// station's restricted account included, could rewrite or delete a wipe record,
// or create one saying "wiped". These pin the boundary that replaced that,
// including every bypass an adversarial review found in its first version
// (camelCase spellings, relation objects, mixed spellings, relabelling a device,
// future dates, a forged history author, side effects lost on a retry).
//
// The repositories are in-memory fakes that behave like TypeORM where it
// matters: update() throws on an empty set (the queue-wedging case), and the
// transaction rolls every table back when its callback throws.

type Row = Record<string, any>;

function fakeRepo(seed: Row[] = []) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  let n = 0;
  return {
    rows,
    failNextSave: false,
    findOne: jest.fn(async ({ where: { id } }: any) => (rows.has(id) ? { id } : null)),
    upsert: jest.fn(async (data: Row) => {
      rows.set(data.id, { ...(rows.get(data.id) ?? {}), ...data });
    }),
    update: jest.fn(async (crit: Row, data: Row) => {
      if (Object.keys(data).length === 0) throw new Error('UpdateValuesMissingError');
      rows.set(crit.id, { ...(rows.get(crit.id) ?? {}), ...data });
    }),
    delete: jest.fn(async ({ id }: Row) => {
      rows.delete(id);
    }),
    create: jest.fn((x: Row) => x),
    save: jest.fn(async function (this: any, x: Row) {
      if (this.failNextSave) {
        this.failNextSave = false;
        throw new Error('connection reset');
      }
      const id = x.id ?? `saved-${++n}`;
      rows.set(id, { ...x, id });
      return x;
    }),
    manager: { query: jest.fn(async () => [{}]) } as any,
  };
}

type Fake = ReturnType<typeof fakeRepo>;

// A transaction over the three fakes: a snapshot on entry, restored if the
// callback throws - which is the whole point of wrapping audit + side effects.
function wireTransaction(assets: Fake, history: Fake, audits: Fake) {
  const byEntity = new Map<unknown, Fake>([
    [Asset, assets],
    [AssetHistory, history],
    [AssetAudit, audits],
  ]);
  const manager = {
    getRepository: (cls: unknown) => byEntity.get(cls),
    createQueryBuilder: () => {
      let target: Fake;
      let row: Row;
      const qb: any = {
        insert: () => qb,
        into: (cls: unknown) => ((target = byEntity.get(cls)!), qb),
        values: (v: Row) => ((row = v), qb),
        orIgnore: () => qb,
        returning: () => qb,
        execute: async () => {
          if (target.rows.has(row.id)) return { raw: [] };
          target.rows.set(row.id, { ...row });
          return { raw: [{ id: row.id }] };
        },
      };
      return qb;
    },
  };
  audits.manager.transaction = jest.fn(async (cb: (m: unknown) => Promise<void>) => {
    const snap = [assets, history, audits].map((f) => new Map(f.rows));
    try {
      await cb(manager);
    } catch (e) {
      [assets, history, audits].forEach((f, i) => {
        f.rows.clear();
        for (const [k, v] of snap[i]) f.rows.set(k, v);
      });
      throw e;
    }
  });
}

const snap = (role: UserRole, permissions: string[], disabled = false): AuthzSnapshot => ({
  role,
  permissions,
  disabled,
  passwordChangedAt: null,
});

const USERS: Record<string, AuthzSnapshot> = {
  admin: snap(UserRole.ADMIN, []),
  // The restricted station account from tools/audit.conf.example.
  station: snap(UserRole.TECHNICIAN, ['goods_in', 'perform_amazon_audit', 'perform_goods_in_audit']),
  tech: snap(UserRole.TECHNICIAN, ['perform_goods_in_audit']),
  wiper: snap(UserRole.TECHNICIAN, ['perform_goods_in_audit', 'record_manual_wipe']),
  viewer: snap(UserRole.TECHNICIAN, ['assets']),
  deleter: snap(UserRole.TECHNICIAN, ['delete_asset']),
  disabledWiper: snap(UserRole.TECHNICIAN, ['perform_goods_in_audit', 'record_manual_wipe'], true),
};

function setup(seed: { audits?: Row[]; history?: Row[]; assets?: Row[] } = {}) {
  const assets = fakeRepo(seed.assets ?? [{ id: 'dev1', auditStatus: 'passed_testing', tag: 'TAG-1' }]);
  const history = fakeRepo(seed.history);
  const audits = fakeRepo(seed.audits);
  const batches = fakeRepo();
  wireTransaction(assets, history, audits);
  const permissions = { getAuthz: jest.fn(async (id: string) => USERS[id] ?? null) };
  const svc = new PowerSyncService(
    assets as never,
    history as never,
    audits as never,
    batches as never,
    permissions as never,
  );
  const as = (id: string) => ({ userId: id, role: USERS[id].role });
  return { svc, assets, history, audits, as };
}

const put = (table: string, id: string, data: Row) => ({ op: 'PUT' as const, table, id, data });
const patch = (table: string, id: string, data: Row) => ({ op: 'PATCH' as const, table, id, data });

describe('offline sync: wipe records are append-only', () => {
  it('a PATCH on an existing wipe record changes nothing, and does not throw', async () => {
    const t = setup({ audits: [{ id: 'a1', dataWipeStatus: 'failed' }] });
    await expect(
      t.svc.applyBatch([patch('asset_audits', 'a1', { data_wipe_status: 'wiped' })], t.as('station')),
    ).resolves.toBeUndefined();
    expect(t.audits.rows.get('a1')!.dataWipeStatus).toBe('failed');
  });

  it('a DELETE on a wipe record is refused, even for an admin', async () => {
    const t = setup({ audits: [{ id: 'a1', dataWipeStatus: 'failed' }] });
    await t.svc.applyBatch([{ op: 'DELETE', table: 'asset_audits', id: 'a1' }], t.as('admin'));
    expect(t.audits.rows.has('a1')).toBe(true);
  });

  it('a PUT that would overwrite an existing wipe record is refused', async () => {
    const t = setup({ audits: [{ id: 'a1', dataWipeStatus: 'failed' }] });
    await t.svc.applyBatch(
      [put('asset_audits', 'a1', { asset_id: 'dev1', data_wipe_status: 'wiped' })],
      t.as('wiper'),
    );
    expect(t.audits.rows.get('a1')!.dataWipeStatus).toBe('failed');
  });

  it('history is append-only too', async () => {
    const t = setup({ history: [{ id: 'h1', notes: 'original' }] });
    await t.svc.applyBatch(
      [patch('asset_history', 'h1', { notes: 'rewritten' }), { op: 'DELETE', table: 'asset_history', id: 'h1' }],
      t.as('admin'),
    );
    expect(t.history.rows.get('h1')!.notes).toBe('original');
  });

  it('one refused write does not stop the rest of the batch', async () => {
    const t = setup({ audits: [{ id: 'a1', dataWipeStatus: 'failed' }] });
    await t.svc.applyBatch(
      [
        { op: 'DELETE', table: 'asset_audits', id: 'a1' },
        put('asset_audits', 'a2', { asset_id: 'dev1', cosmetic_grade: 'grade_b' }),
      ],
      t.as('station'),
    );
    expect(t.audits.rows.get('a2')!.cosmeticGrade).toBe('grade_b');
  });
});

describe('offline sync: an audit and its side effects are one unit', () => {
  it('a failure between the audit and its history event leaves neither - and the retry lands both', async () => {
    const t = setup();
    const entry = put('asset_audits', 'a9', { asset_id: 'dev1', cosmetic_grade: 'grade_b' });
    t.history.failNextSave = true;
    await expect(t.svc.applyBatch([entry], t.as('station'))).rejects.toThrow('connection reset');
    expect(t.audits.rows.has('a9')).toBe(false); // rolled back, not stranded
    await t.svc.applyBatch([entry], t.as('station')); // PowerSync retries the batch
    expect(t.audits.rows.has('a9')).toBe(true);
    expect([...t.history.rows.values()].filter((h) => h.assetId === 'dev1')).toHaveLength(1);
  });

  it('a retried upload of an audit that fully landed is a no-op: no duplicate history', async () => {
    const t = setup();
    const entry = put('asset_audits', 'a9', { asset_id: 'dev1', cosmetic_grade: 'grade_b' });
    await t.svc.applyBatch([entry], t.as('station'));
    await t.svc.applyBatch([entry], t.as('station'));
    expect([...t.history.rows.values()].filter((h) => h.assetId === 'dev1')).toHaveLength(1);
  });
});

describe('offline sync: who may record an audit', () => {
  it('needs the same grant as the online route - a viewer is refused', async () => {
    const t = setup();
    await t.svc.applyBatch([put('asset_audits', 'a9', { asset_id: 'dev1' })], t.as('viewer'));
    expect(t.audits.rows.has('a9')).toBe(false);
  });

  it('the restricted station account can still record a normal audit, credited to itself', async () => {
    const t = setup();
    await t.svc.applyBatch(
      [put('asset_audits', 'a9', { asset_id: 'dev1', cosmetic_grade: 'grade_a' })],
      t.as('station'),
    );
    expect(t.audits.rows.get('a9')).toMatchObject({ cosmeticGrade: 'grade_a', auditedById: 'station' });
  });

  it('every field the offline audit form sends still lands', async () => {
    const t = setup();
    // Exactly the columns audit-form.tsx INSERTs.
    await t.svc.applyBatch(
      [
        put('asset_audits', 'a9', {
          asset_id: 'dev1',
          audit_status: 'passed_testing',
          cosmetic_grade: 'grade_b',
          functional_tests: '{"keyboard":true}',
          data_wipe_status: 'failed',
          data_wipe_method: 'Overwrite',
          final_disposition: 'sell',
          notes: 'hinge loose',
          audit_kind: 'goods_in',
          created_at: '2026-09-01T08:00:00.000Z', // safely in the past
        }),
      ],
      t.as('tech'),
    );
    expect(t.audits.rows.get('a9')).toMatchObject({
      auditStatus: 'passed_testing',
      cosmeticGrade: 'grade_b',
      functionalTests: { keyboard: true },
      dataWipeStatus: 'failed',
      dataWipeMethod: 'Overwrite',
      finalDisposition: 'sell',
      notes: 'hinge loose',
      auditKind: 'goods_in',
      createdAt: '2026-09-01T08:00:00.000Z',
    });
  });

  it('history rows are credited to the uploader, not NULL and not whoever the client names', async () => {
    const t = setup();
    await t.svc.applyBatch(
      [
        put('asset_history', 'h1', { asset_id: 'dev1', event_type: 'created', user_id: null }),
        put('asset_history', 'h2', { asset_id: 'dev1', event_type: 'created', user_id: 'admin' }),
        // Review finding: user_id then camelCase userId used to let the second win.
        put('asset_history', 'h3', { asset_id: 'dev1', event_type: 'created', user_id: 'x', userId: 'admin' }),
      ],
      t.as('tech'),
    );
    for (const id of ['h1', 'h2', 'h3']) expect(t.history.rows.get(id)!.userId).toBe('tech');
  });
});

describe('offline sync: hand-typed wipes', () => {
  const claim = { asset_id: 'dev1', data_wipe_status: 'wiped', audit_status: 'data_wiped', cosmetic_grade: 'grade_b' };

  it('without the grant, the CLAIM is dropped - the audit lands, noted, and the device is not marked wiped', async () => {
    const t = setup();
    await t.svc.applyBatch([put('asset_audits', 'a9', claim)], t.as('tech'));
    const row = t.audits.rows.get('a9')!;
    expect(row.dataWipeStatus).toBeUndefined();
    expect(row.auditStatus).toBeUndefined();
    expect(row.wipeSource).toBeUndefined();
    expect(row.cosmeticGrade).toBe('grade_b');
    expect(row.notes).toMatch(/Wipe not recorded/);
    expect(t.assets.rows.get('dev1')!.auditStatus).toBe('passed_testing');
  });

  it('with the grant, it is stored as wiped and labelled manual', async () => {
    const t = setup();
    await t.svc.applyBatch([put('asset_audits', 'a9', claim)], t.as('wiper'));
    expect(t.audits.rows.get('a9')).toMatchObject({ dataWipeStatus: 'wiped', wipeSource: 'manual' });
    expect(t.assets.rows.get('dev1')!.auditStatus).toBe('data_wiped');
  });

  it('admins hold it by role', async () => {
    const t = setup();
    await t.svc.applyBatch([put('asset_audits', 'a9', claim)], t.as('admin'));
    expect(t.audits.rows.get('a9')!.dataWipeStatus).toBe('wiped');
  });

  it('a disabled account holds nothing', async () => {
    const t = setup();
    await t.svc.applyBatch([put('asset_audits', 'a9', claim)], t.as('disabledWiper'));
    expect(t.audits.rows.has('a9')).toBe(false);
  });

  it('a hand-typed FAILED wipe needs no special grant, and is labelled manual', async () => {
    const t = setup();
    await t.svc.applyBatch(
      [put('asset_audits', 'a9', { asset_id: 'dev1', data_wipe_status: 'failed' })],
      t.as('tech'),
    );
    expect(t.audits.rows.get('a9')).toMatchObject({ dataWipeStatus: 'failed', wipeSource: 'manual' });
  });

  it('the claim cannot move to the device instead: a status-only PATCH is skipped, not thrown', async () => {
    const t = setup();
    await expect(
      t.svc.applyBatch([patch('assets', 'dev1', { audit_status: 'data_wiped' })], t.as('tech')),
    ).resolves.toBeUndefined();
    expect(t.assets.rows.get('dev1')!.auditStatus).toBe('passed_testing');
  });

  it('a device PATCH keeps its other fields when the claim is dropped', async () => {
    const t = setup();
    await t.svc.applyBatch(
      [patch('assets', 'dev1', { audit_status: 'data_wiped', condition_grade: 'grade_c' })],
      t.as('tech'),
    );
    expect(t.assets.rows.get('dev1')).toMatchObject({ auditStatus: 'passed_testing', conditionGrade: 'grade_c' });
  });
});

describe('offline sync: the bypasses found in review', () => {
  it('camelCase spellings are dropped: no station-worded forgery, no colleague as author, no 2099 date', async () => {
    const t = setup();
    await t.svc.applyBatch(
      [
        put('asset_audits', 'a9', {
          asset_id: 'dev1',
          dataWipeStatus: 'wiped',
          dataWipeMethod: 'NIST 800-88 Purge',
          wipeSource: 'station',
          auditedById: 'admin',
          createdAt: '2099-01-01T00:00:00Z',
        }),
      ],
      t.as('tech'),
    );
    const row = t.audits.rows.get('a9')!;
    expect(row.dataWipeStatus).toBeUndefined();
    expect(row.wipeSource).toBeUndefined();
    expect(row.auditedById).toBe('tech');
    expect(row.createdAt).toBeUndefined();
  });

  it('a relation object cannot name another author', async () => {
    const t = setup();
    await t.svc.applyBatch(
      [put('asset_audits', 'a9', { asset_id: 'dev1', auditedBy: { id: 'admin' } })],
      t.as('tech'),
    );
    const row = t.audits.rows.get('a9')!;
    expect(row.auditedBy).toBeUndefined();
    expect(row.auditedById).toBe('tech');
  });

  it('mixed spellings are dropped too', async () => {
    const t = setup();
    await t.svc.applyBatch(
      [put('asset_audits', 'a9', { asset_id: 'dev1', data_wipeStatus: 'wiped' })],
      t.as('tech'),
    );
    expect(t.audits.rows.get('a9')!.dataWipeStatus).toBeUndefined();
  });

  it('a camelCase device status or hardware profile is dropped', async () => {
    const t = setup();
    await t.svc.applyBatch(
      [
        patch('assets', 'dev1', {
          auditStatus: 'data_wiped',
          hardwareProfile: { storage: [{ capacity: '2 TB', type: 'NVMe SSD' }] },
        }),
      ],
      t.as('viewer'),
    );
    const dev = t.assets.rows.get('dev1')!;
    expect(dev.auditStatus).toBe('passed_testing');
    expect(dev.hardwareProfile).toBeUndefined();
  });

  it("a device's identity cannot be changed once it exists - no relabelling a wipe onto another machine", async () => {
    const t = setup();
    await t.svc.applyBatch(
      [
        patch('assets', 'dev1', { serial_number: 'S2', device_type: 'Laptop', tag: 'TAG-X', name: 'Other', category: 'X' }),
        put('assets', 'dev1', { tag: 'TAG-Y', name: 'Other', stock_status: 'received' }), // PUT on an existing id
      ],
      t.as('viewer'),
    );
    const dev = t.assets.rows.get('dev1')!;
    expect(dev.tag).toBe('TAG-1');
    expect(dev.serialNumber).toBeUndefined();
    expect(dev.deviceType).toBeUndefined();
    expect(dev.name).toBeUndefined();
    expect(dev.stockStatus).toBe('received'); // the rest of that PUT still applies
  });

  it('a NEW device created offline keeps its tag and name - the scan page still works', async () => {
    const t = setup();
    await t.svc.applyBatch(
      [put('assets', 'new1', { tag: 'T-100', name: 'T-100', category: 'Uncategorised', stock_status: 'received' })],
      t.as('tech'),
    );
    expect(t.assets.rows.get('new1')).toMatchObject({ tag: 'T-100', name: 'T-100', category: 'Uncategorised' });
  });

  it('a future created_at is dropped (the DB default applies); a real one is kept', async () => {
    const t = setup();
    await t.svc.applyBatch(
      [
        put('asset_audits', 'a1', { asset_id: 'dev1', created_at: '2099-01-01T00:00:00Z' }),
        put('asset_audits', 'a2', { asset_id: 'dev1', created_at: '2026-09-01T10:00:00.000Z' }),
      ],
      t.as('station'),
    );
    expect(t.audits.rows.get('a1')!.createdAt).toBeUndefined();
    expect(t.audits.rows.get('a2')!.createdAt).toBe('2026-09-01T10:00:00.000Z');
  });
});

describe('offline sync: server-owned fields and deletes', () => {
  it('a client cannot attach a hardware profile - the certificate prints its drive list from one', async () => {
    const t = setup();
    const fake = { storage: [{ capacity: '1 TB', type: 'SSD' }] };
    await t.svc.applyBatch(
      [
        put('asset_audits', 'a9', { asset_id: 'dev1', hardware_profile: fake }),
        patch('assets', 'dev1', { hardware_profile: fake, condition_grade: 'grade_a' }),
      ],
      t.as('wiper'),
    );
    expect(t.audits.rows.get('a9')!.hardwareProfile).toBeUndefined();
    expect(t.assets.rows.get('dev1')!.hardwareProfile).toBeUndefined();
  });

  it('deleting a device needs Delete Asset', async () => {
    const t = setup({ assets: [{ id: 'dev1' }, { id: 'dev2' }] });
    await t.svc.applyBatch([{ op: 'DELETE', table: 'assets', id: 'dev1' }], t.as('station'));
    await t.svc.applyBatch([{ op: 'DELETE', table: 'assets', id: 'dev2' }], t.as('deleter'));
    expect(t.assets.rows.has('dev1')).toBe(true);
    expect(t.assets.rows.has('dev2')).toBe(false);
  });
});

describe('acceptableCreatedAt', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  it('keeps a real past or present time', () => {
    expect(acceptableCreatedAt('2026-09-19T11:59:00.000Z', now)).toBe(true);
    expect(acceptableCreatedAt('2026-08-01T00:00:00Z', now)).toBe(true);
  });
  it("reads SQLite's zone-less datetime('now') as UTC", () => {
    expect(acceptableCreatedAt('2026-09-19 11:59:00', now)).toBe(true);
    expect(acceptableCreatedAt('2026-09-19 12:30:00', now)).toBe(false);
  });
  it('refuses the future beyond a few minutes, garbage and non-strings', () => {
    expect(acceptableCreatedAt('2026-09-19T12:03:00Z', now)).toBe(true); // clock skew
    expect(acceptableCreatedAt('2099-01-01T00:00:00Z', now)).toBe(false);
    expect(acceptableCreatedAt('not a date', now)).toBe(false);
    expect(acceptableCreatedAt(1789000000000, now)).toBe(false);
  });
});
