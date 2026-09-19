import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DataSource, In } from 'typeorm';
import {
  openPgTestDatabase,
  pgTestPort,
} from '../database/pg-test-db-for-spec';
import { User, UserRole } from '../users/user.entity';
import { Batch } from '../batches/batch.entity';
import { Asset } from '../assets/asset.entity';
import { AssetAudit, DataWipeStatus } from '../assets/asset-audit.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import { rollupFor } from '../assets/certificates.service';
import type { IngestAuditDto } from './dto/ingest-audit.dto';
import { DevicesService } from './devices.service';

// apps/api/sql/remediation-wave2-per-drive-refusals.sql is the read-only
// query the owner runs on production before wave 2 is pushed: which machines
// stop being certifiable under the per-drive rule. It is a SQL copy of
// wipe-rollup.ts, so this spec files the same machines through the real
// ingest into real Postgres and checks the query lists exactly the machines
// the roll-up judges per drive and refuses.
//
//   ALS_PG_TEST_PORT=55433 npx jest wipe-rollup-sql.pg

const SQL = path.join(
  __dirname,
  '..',
  '..',
  'sql',
  'remediation-wave2-per-drive-refusals.sql',
);

const maybe = pgTestPort ? describe : describe.skip;

maybe('the wave-2 per-drive refusal query (Postgres)', () => {
  let ds: DataSource;
  let svc: DevicesService;
  let userId: string;
  const run = `SQL-${Date.now()}`;

  beforeAll(async () => {
    ds = await openPgTestDatabase();
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        name: 'Station',
        email: `station-sql-${Date.now()}@example.invalid`,
        passwordHash: 'x',
        role: UserRole.ADMIN,
      }),
    );
    userId = user.id;
    svc = new DevicesService(
      ds.getRepository(User),
      ds.getRepository(Batch),
      ds.getRepository(Asset),
      ds.getRepository(AssetAudit),
      ds.getRepository(AssetHistory),
      { record: () => Promise.resolve() } as never,
      {
        getAuthz: () =>
          Promise.resolve({
            role: UserRole.ADMIN,
            permissions: [],
            disabled: false,
          }),
      } as never,
    );
  }, 60000);

  afterAll(async () => {
    await ds?.destroy();
  });

  const drive = (serial: string, extra: Record<string, unknown> = {}) => ({
    model: 'Samsung SSD 980',
    serialNumber: serial,
    interface: 'NVMe',
    type: 'NVMe',
    capacity: '512GB',
    ...extra,
  });

  const payload = (
    host: string,
    storage: unknown[],
    wipe?: { serial?: string; status: DataWipeStatus; wipedAt?: Date },
  ) =>
    ({
      auditKind: 'amazon',
      profile: {
        identification: {
          manufacturer: 'Dell',
          model: 'Latitude 7490',
          serialNumber: host,
        },
        storage,
      },
      ...(wipe
        ? {
            dataWipeStatus: wipe.status,
            dataWipeMethod: 'NVMe crypto erase — verified (reads as random)',
            ...(wipe.serial
              ? { wipedDrive: { serialNumber: wipe.serial } }
              : {}),
            ...(wipe.wipedAt ? { wipedAt: wipe.wipedAt.toISOString() } : {}),
          }
        : {}),
    }) as IngestAuditDto;

  const W = DataWipeStatus.WIPED;
  const F = DataWipeStatus.FAILED;
  const ago = (min: number) => new Date(Date.now() - min * 60_000);

  // Each case: the drives its profile lists, and the wipes filed in order.
  const cases: Record<
    string,
    {
      storage: (h: string) => unknown[];
      wipes: (
        h: string,
      ) => Array<{ serial?: string; status: DataWipeStatus; wipedAt?: Date }>;
    }
  > = {
    'two listed, one wiped': {
      storage: (h) => [drive(`${h}-A`), drive(`${h}-B`)],
      wipes: (h) => [{ serial: `${h}-A`, status: W }],
    },
    'two listed, both wiped': {
      storage: (h) => [drive(`${h}-A`), drive(`${h}-B`)],
      wipes: (h) => [
        { serial: `${h}-A`, status: W },
        { serial: `${h}-B`, status: W },
      ],
    },
    'one wiped, one failed': {
      storage: (h) => [drive(`${h}-A`), drive(`${h}-B`)],
      wipes: (h) => [
        { serial: `${h}-A`, status: W },
        { serial: `${h}-B`, status: F },
      ],
    },
    'failed then re-wiped': {
      storage: (h) => [drive(`${h}-A`), drive(`${h}-B`)],
      wipes: (h) => [
        { serial: `${h}-B`, status: F },
        { serial: `${h}-A`, status: W },
        { serial: `${h}-b`, status: W },
      ],
    },
    'old stick only (no drive named)': {
      storage: (h) => [drive(`${h}-A`), drive(`${h}-B`)],
      wipes: () => [{ status: W }],
    },
    'USB stick and eMMC boot partition are not drives': {
      storage: (h) => [
        drive(`${h}-A`),
        drive(`${h}-U`, { interface: 'USB', type: 'USB', capacity: '32GB' }),
        drive(`${h}-M`, { interface: 'MMC', type: 'eMMC', capacity: '0GB' }),
        drive(`${h}-K`, { capacity: '4MB' }),
      ],
      wipes: (h) => [{ serial: `${h}-A`, status: W }],
    },
    'station clock says the failure is newer': {
      storage: (h) => [drive(`${h}-A`)],
      wipes: (h) => [
        { serial: `${h}-A`, status: F, wipedAt: ago(1) },
        { serial: `${h}-A`, status: W, wipedAt: ago(10) },
      ],
    },
    'one wiped, then a hand record for the machine': {
      storage: (h) => [drive(`${h}-A`), drive(`${h}-B`)],
      wipes: (h) => [{ serial: `${h}-A`, status: W }],
    },
    // An older hand record is superseded by the station's per-drive ones.
    'a hand record, then one drive wiped at the station': {
      storage: (h) => [drive(`${h}-A`), drive(`${h}-B`)],
      wipes: (h) => [{ serial: `${h}-A`, status: W }],
    },
  };

  it('lists exactly the machines the per-drive roll-up refuses', async () => {
    const tags: string[] = [];
    const byTag = new Map<string, string>();
    let n = 0;
    for (const [name, c] of Object.entries(cases)) {
      const host = `${run}-${++n}`;
      const { assetId, tag } = await svc.ingest(
        userId,
        payload(host, c.storage(host)),
      );
      const handRecord = () =>
        ds.getRepository(AssetAudit).save(
          ds.getRepository(AssetAudit).create({
            assetId,
            dataWipeStatus: DataWipeStatus.WIPED,
            dataWipeMethod: 'Physical destruction',
            wipeSource: 'manual',
            auditedById: userId,
          }),
        );
      if (name.startsWith('a hand record')) await handRecord();
      for (const w of c.wipes(host))
        await svc.ingest(userId, payload(host, c.storage(host), w));
      if (name.includes('then a hand record')) await handRecord();
      tags.push(tag);
      byTag.set(tag, assetId);
    }

    // What the roll-up itself says, from the same rows.
    const expected: string[] = [];
    for (const [tag, assetId] of byTag) {
      const rows = await ds.getRepository(AssetAudit).find({
        where: { assetId, dataWipeStatus: In([W, F]) },
      });
      const r = rollupFor(rows);
      if (r.basis === 'drives' && r.verdict !== 'wiped') expected.push(tag);
    }

    const file = readFileSync(SQL, 'utf8');
    const body = /BEGIN READ ONLY;([\s\S]*?);\s*ROLLBACK;/.exec(file)?.[1];
    expect(body).toBeTruthy();
    const qr = ds.createQueryRunner();
    await qr.connect();
    let listed: Array<{ tag: string; not_wiped: string | null }>;
    try {
      // The file's own guarantee: it runs inside a READ ONLY transaction.
      await qr.query('BEGIN READ ONLY');
      listed = (await qr.query(
        `SELECT * FROM (${body}) q WHERE q.tag = ANY($1)`,
        [tags],
      )) as Array<{ tag: string; not_wiped: string | null }>;
    } finally {
      await qr.query('ROLLBACK');
      await qr.release();
    }

    expect(listed.map((r) => r.tag).sort()).toEqual(expected.sort());
    // Sanity: the cases really do split both ways.
    expect(expected.length).toBe(4);
    const first = listed.find((r) => r.tag === tags[0]);
    expect(first?.not_wiped).toBe(`${run}-1-B`.toUpperCase());
  }, 120000);
});
