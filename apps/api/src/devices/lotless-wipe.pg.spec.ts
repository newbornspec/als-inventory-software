import { DataSource } from 'typeorm';
import {
  openPgTestDatabase,
  pgTestPort,
} from '../database/pg-test-db-for-spec';
import { User, UserRole } from '../users/user.entity';
import { Batch } from '../batches/batch.entity';
import { Asset, AssetAuditStatus } from '../assets/asset.entity';
import { AssetAudit } from '../assets/asset-audit.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import { CertificatesService } from '../assets/certificates.service';
import { AuditsService } from '../audits/audits.service';
import type { IngestAuditDto } from './dto/ingest-audit.dto';
import { DevicesService, LOTLESS_WIPE_NOTE } from './devices.service';

// Incident 2026-09-19, against REAL Postgres: the station's stuck wipe
// record (no auditKind, no lotId, an account with no active lot) is filed
// with batch_id NULL and a note, is certifiable, and shows in the Audit
// workspace under "unclassified". The in-memory cases are in
// lotless-wipe.spec.ts; this proves the real columns and queries take a
// lotless, non-Amazon device.
//
//   ALS_PG_TEST_PORT=55440 npx jest lotless-wipe.pg

const maybe = pgTestPort ? describe : describe.skip;

maybe('a wipe filed with no lot (Postgres)', () => {
  let ds: DataSource;
  let devices: DevicesService;
  let userId: string;

  beforeAll(async () => {
    ds = await openPgTestDatabase();
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        name: 'Station',
        email: `station-lotless-${Date.now()}@example.invalid`,
        passwordHash: 'x',
        role: UserRole.ADMIN,
      }),
    );
    userId = user.id;
    devices = new DevicesService(
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

  it('files the stuck payload lotless, certifies it, and lists it in the workspace', async () => {
    const host = `LOTLESS-${Date.now()}`;
    const stuck = {
      profile: {
        identification: {
          manufacturer: 'Dell Inc.',
          model: 'Latitude 5420',
          serialNumber: host,
        },
        storage: [
          { serialNumber: `${host}-D`, model: 'Samsung PM9A1', type: 'NVMe' },
        ],
      },
      dataWipeMethod: 'NVMe crypto erase — verified (reads as random)',
      dataWipeStatus: 'wiped',
      methodAttempted: 'nvme-sanitize-crypto',
      methodRequested: 'auto',
      sanitisationLevel: 'purge',
      toolCommit: 'c2ea936',
      toolName: 'als-audit-station',
      toolVersion: '2026.09.19',
      verification: 'clean',
      wipeLimitations: [],
      wipeStartedAt: new Date(Date.now() - 120000).toISOString(),
      wipedAt: new Date(Date.now() - 60000).toISOString(),
      wipedAtClock: 'network',
      wipedDrive: {
        serialNumber: `${host}-D`,
        model: 'Samsung PM9A1',
        transport: 'nvme',
        devicePath: '/dev/nvme0n1',
      },
    } as unknown as IngestAuditDto;

    const { assetId, lot } = await devices.ingest(userId, stuck);
    expect(lot).toBeNull();

    const asset = await ds
      .getRepository(Asset)
      .findOneByOrFail({ id: assetId });
    expect(asset.batchId).toBeNull();
    expect(asset.auditStatus).toBe(AssetAuditStatus.DATA_WIPED);
    const [row] = await ds.getRepository(AssetAudit).findBy({ assetId });
    expect(row.auditKind).toBeNull();
    expect(row.notes).toContain(LOTLESS_WIPE_NOTE);
    expect(row.sanitisationLevel).toBe('purge');
    const [hist] = await ds.getRepository(AssetHistory).findBy({ assetId });
    expect(hist.notes).toBe(LOTLESS_WIPE_NOTE);

    const certs = new CertificatesService(
      ds.getRepository(Asset),
      ds.getRepository(AssetAudit),
      ds.getRepository(Batch),
    );
    await expect(certs.eligibility(assetId)).resolves.toMatchObject({
      available: true,
      verdict: 'wiped',
    });
    const { buffer } = await certs.erasureCertificate(assetId);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');

    const workspace = new AuditsService(ds.getRepository(AssetAudit));
    const today = await workspace.days(undefined, 1, 'unclassified');
    expect(today.length).toBe(1);
    const listed = await workspace.day(today[0].day, undefined, 'unclassified');
    const mine = listed.find((d) => d.assetId === assetId);
    expect(mine).toBeDefined();
    expect(mine!.dataWipeStatus).toBe('wiped');
    expect(mine!.events[0].notes).toContain(LOTLESS_WIPE_NOTE);
  }, 60000);
});
