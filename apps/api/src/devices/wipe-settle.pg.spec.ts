import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from '../database/entities';
import { User, UserRole } from '../users/user.entity';
import { Batch } from '../batches/batch.entity';
import { Asset, AssetAuditStatus } from '../assets/asset.entity';
import { AssetAudit, DataWipeStatus } from '../assets/asset-audit.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import type { IngestAuditDto } from './dto/ingest-audit.dto';
import { DevicesService } from './devices.service';

// Plan step 23, against REAL Postgres: two drives of one machine filed at the
// same moment - drive A wiped, drive B failed - must always leave the asset
// data_wipe_failed, whichever request finishes last. Without the row lock in
// settleWipeStatus, the request that read the rows before the other's row
// existed could finish last and write data_wiped.
//
// Needs a migrated database, so it runs only when ALS_PG_TEST_PORT is set
// (skipped in the normal `npx jest` run and in CI):
//   docker run -d --name als-api-pg -e POSTGRES_USER=als_inventory \
//     -e POSTGRES_PASSWORD=als_inventory_ci -e POSTGRES_DB=als_inventory \
//     -p 55437:5432 postgres:16
//   DB_PORT=55437 DB_PASSWORD=als_inventory_ci npm run migration:run
//   ALS_PG_TEST_PORT=55437 npx jest wipe-settle.pg

const port = process.env.ALS_PG_TEST_PORT;
const maybe = port ? describe : describe.skip;

maybe('settleWipeStatus under concurrent ingests (Postgres)', () => {
  let ds: DataSource;
  let svc: DevicesService;
  let userId: string;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.ALS_PG_TEST_HOST ?? 'localhost',
      port: parseInt(port!, 10),
      username: 'als_inventory',
      password: process.env.ALS_PG_TEST_PASSWORD ?? 'als_inventory_ci',
      database: 'als_inventory',
      entities: ALL_ENTITIES,
      synchronize: false,
      // Enough connections that the two ingests really run side by side.
      extra: { max: 10 },
    });
    await ds.initialize();
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        name: 'Station',
        email: `station-${Date.now()}@example.invalid`,
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

  const payload = (host: string, drive: string, status?: DataWipeStatus) =>
    ({
      auditKind: 'amazon',
      profile: {
        identification: {
          manufacturer: 'Dell',
          model: 'Latitude 7490',
          serialNumber: host,
        },
        storage: [
          {
            model: 'Samsung SSD 980',
            serialNumber: `${host}-A`,
            interface: 'NVMe',
            type: 'NVMe',
          },
          {
            model: 'ST1000LM',
            serialNumber: `${host}-B`,
            interface: 'SATA',
            type: 'HDD',
          },
        ],
      },
      ...(status
        ? {
            dataWipeStatus: status,
            dataWipeMethod: 'NVMe crypto erase — verified (reads as random)',
            wipedDrive: { serialNumber: `${host}-${drive}` },
          }
        : {}),
    }) as IngestAuditDto;

  it('two concurrent ingests, one failed: always data_wipe_failed', async () => {
    const runs = 25;
    const outcomes: Array<string | null> = [];
    for (let i = 0; i < runs; i++) {
      const host = `PG-${Date.now()}-${i}`;
      // The machine exists first (its capture), as it does at the station.
      const { assetId } = await svc.ingest(userId, payload(host, ''));
      // Alternate which request starts first.
      const a = () =>
        svc.ingest(userId, payload(host, 'A', DataWipeStatus.WIPED));
      const b = () =>
        svc.ingest(userId, payload(host, 'B', DataWipeStatus.FAILED));
      await Promise.all(i % 2 ? [a(), b()] : [b(), a()]);
      const asset = await ds
        .getRepository(Asset)
        .findOneByOrFail({ id: assetId });
      outcomes.push(asset.auditStatus);
    }
    expect(outcomes).toEqual(
      Array(runs).fill(AssetAuditStatus.DATA_WIPE_FAILED),
    );
  }, 120000);

  // The random interleavings above rarely hit the narrow window, so this one
  // forces it: drive B's request holds the asset row while drive A's settle
  // starts, and only then files B's FAILED row and B's verdict. Without the
  // lock, A's settle has already read "only A, wiped" and - finishing last -
  // writes data_wiped over B's data_wipe_failed. (Verified: with setLock
  // removed from settleWipeStatus this test fails.)
  it('the settle that runs last reads the rows filed while it waited', async () => {
    const host = `PG-${Date.now()}-forced`;
    const bare = payload(host, '');
    // No storage list, so drive A alone would count as the whole machine.
    (bare.profile as { storage?: unknown }).storage = undefined;
    const { assetId } = await svc.ingest(userId, bare);
    const audits = ds.getRepository(AssetAudit);
    const row = (serial: string, status: DataWipeStatus) =>
      audits.create({
        assetId,
        dataWipeStatus: status,
        dataWipeMethod: 'NVMe crypto erase',
        wipeSource: 'station',
        hardwareProfile: {},
        wipedDriveSerial: serial,
        wipedDrive: { serialNumber: serial },
      });
    await audits.save(row('A', DataWipeStatus.WIPED));

    const b = ds.createQueryRunner();
    await b.connect();
    await b.startTransaction();
    try {
      await b.query('SELECT id FROM assets WHERE id = $1 FOR UPDATE', [
        assetId,
      ]);
      const settling = (
        svc as unknown as { settleWipeStatus: (id: string) => Promise<void> }
      ).settleWipeStatus(assetId);
      await new Promise((r) => setTimeout(r, 500));
      await b.manager.save(row('B', DataWipeStatus.FAILED));
      await b.query('UPDATE assets SET audit_status = $1 WHERE id = $2', [
        AssetAuditStatus.DATA_WIPE_FAILED,
        assetId,
      ]);
      await b.commitTransaction();
      await settling;
    } finally {
      await b.release();
    }
    const asset = await ds
      .getRepository(Asset)
      .findOneByOrFail({ id: assetId });
    expect(asset.auditStatus).toBe(AssetAuditStatus.DATA_WIPE_FAILED);
  }, 60000);

  it('two concurrent ingests, both wiped: data_wiped', async () => {
    const host = `PG-${Date.now()}-ok`;
    const { assetId } = await svc.ingest(userId, payload(host, ''));
    await Promise.all([
      svc.ingest(userId, payload(host, 'A', DataWipeStatus.WIPED)),
      svc.ingest(userId, payload(host, 'B', DataWipeStatus.WIPED)),
    ]);
    const asset = await ds
      .getRepository(Asset)
      .findOneByOrFail({ id: assetId });
    expect(asset.auditStatus).toBe(AssetAuditStatus.DATA_WIPED);
  }, 60000);
});
