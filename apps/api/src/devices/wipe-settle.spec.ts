import { AssetAuditStatus } from '../assets/asset.entity';
import { DataWipeStatus } from '../assets/asset-audit.entity';
import type { IngestAuditDto } from './dto/ingest-audit.dto';
import { ingestHarness } from './ingest-harness-for-spec';

// Plan step 23: the asset's wipe status comes from EVERY drive's record, not
// from whichever record arrived last. The lock that makes this hold under
// concurrent requests is proven against real Postgres in
// wipe-settle.pg.spec.ts.

const profile = {
  identification: {
    manufacturer: 'Dell',
    model: 'Latitude 7490',
    serialNumber: 'HOST-1',
  },
  storage: [
    {
      model: 'Samsung SSD 980',
      serialNumber: 'S-A',
      interface: 'NVMe',
      type: 'NVMe',
    },
    { model: 'ST1000LM', serialNumber: 'S-B', interface: 'SATA', type: 'HDD' },
  ],
};

const wipe = (
  serial: string,
  status: DataWipeStatus,
  extra: Partial<IngestAuditDto> = {},
) =>
  ({
    profile,
    auditKind: 'amazon',
    dataWipeStatus: status,
    dataWipeMethod: 'NVMe crypto erase — verified (reads as random)',
    wipedDrive: { serialNumber: serial },
    ...extra,
  }) as IngestAuditDto;

const statusAfter = async (...payloads: IngestAuditDto[]) => {
  const { svc, assets } = ingestHarness();
  for (const p of payloads) await svc.ingest('u1', p);
  expect(assets).toHaveLength(1);
  return assets[0].auditStatus;
};

describe('ingest settles the asset wipe status per drive', () => {
  it('[A wiped, B failed] = data_wipe_failed', async () => {
    expect(
      await statusAfter(
        wipe('S-A', DataWipeStatus.WIPED),
        wipe('S-B', DataWipeStatus.FAILED),
      ),
    ).toBe(AssetAuditStatus.DATA_WIPE_FAILED);
  });

  it('[B failed, A wiped] = data_wipe_failed (the order used to decide it)', async () => {
    expect(
      await statusAfter(
        wipe('S-B', DataWipeStatus.FAILED),
        wipe('S-A', DataWipeStatus.WIPED),
      ),
    ).toBe(AssetAuditStatus.DATA_WIPE_FAILED);
  });

  it('only one of two listed drives wiped so far = data_wipe_failed (D23: no enum change)', async () => {
    expect(await statusAfter(wipe('S-A', DataWipeStatus.WIPED))).toBe(
      AssetAuditStatus.DATA_WIPE_FAILED,
    );
  });

  it('both wiped = data_wiped; B failed and then re-wiped = data_wiped', async () => {
    expect(
      await statusAfter(
        wipe('S-A', DataWipeStatus.WIPED),
        wipe('S-B', DataWipeStatus.WIPED),
      ),
    ).toBe(AssetAuditStatus.DATA_WIPED);
    expect(
      await statusAfter(
        wipe('S-A', DataWipeStatus.WIPED),
        wipe('S-B', DataWipeStatus.FAILED),
        wipe('S-B', DataWipeStatus.WIPED),
      ),
    ).toBe(AssetAuditStatus.DATA_WIPED);
  });

  it('an explicit data_wiped in a per-drive payload goes through the roll-up too', async () => {
    expect(
      await statusAfter(
        wipe('S-B', DataWipeStatus.FAILED),
        wipe('S-A', DataWipeStatus.WIPED, {
          auditStatus: AssetAuditStatus.DATA_WIPED,
        }),
      ),
    ).toBe(AssetAuditStatus.DATA_WIPE_FAILED);
  });

  it("never overwrites a person's call", async () => {
    const { svc, assets } = ingestHarness();
    await svc.ingest('u1', wipe('S-A', DataWipeStatus.WIPED));
    assets[0].auditStatus = AssetAuditStatus.READY_FOR_SALE;
    await svc.ingest('u1', wipe('S-B', DataWipeStatus.FAILED));
    expect(assets[0].auditStatus).toBe(AssetAuditStatus.READY_FOR_SALE);
  });

  it('a capture with no wipe keeps the old behaviour (power-on floor)', async () => {
    const { svc, assets } = ingestHarness();
    await svc.ingest('u1', { profile, auditKind: 'amazon' });
    expect(assets[0].auditStatus).toBe(AssetAuditStatus.POWER_ON);
  });

  // Deliberate, owner-reversible (review, wave 2): records from an old stick
  // name no drive, so for them the interim D11 rule decides the STATUS too,
  // not only the certificate. On master "latest wins" read a two-drive
  // laptop whose second drive failed a minute before the first was wiped as
  // data_wiped - the failure this remediation exists for. The cost: a
  // single-drive machine that failed and was re-wiped on an old stick within
  // 24 hours reads data_wipe_failed - and so sits in Quarantine - with its
  // certificate refused, until a wipe is filed at least 24 hours after the
  // failure. The window is measured between the RECORDS, not against the
  // clock: time passing clears nothing, and neither does a re-capture.
  it('old-stick records (no drive identity): D11 decides the status too', async () => {
    const legacy = (status: DataWipeStatus) =>
      ({
        profile,
        auditKind: 'amazon',
        dataWipeStatus: status,
        dataWipeMethod: 'NVMe crypto erase',
      }) as IngestAuditDto;
    expect(
      await statusAfter(
        legacy(DataWipeStatus.FAILED),
        legacy(DataWipeStatus.WIPED),
      ),
    ).toBe(AssetAuditStatus.DATA_WIPE_FAILED);
    expect(await statusAfter(legacy(DataWipeStatus.WIPED))).toBe(
      AssetAuditStatus.DATA_WIPED,
    );
  });

  // Cross-check, wave 2: pins what the comment above now says, because the
  // code comment used to claim the block lasted "24 hours after the failure".
  it('old stick, failed then re-wiped: only a wipe filed 24 h+ after the failure clears it', async () => {
    const legacy = (status: DataWipeStatus, wipedAt?: string) =>
      ({
        profile,
        auditKind: 'amazon',
        dataWipeStatus: status,
        dataWipeMethod: 'NVMe crypto erase',
        ...(wipedAt ? { wipedAt } : {}),
      }) as IngestAuditDto;
    const { svc, assets, audits } = ingestHarness();
    await svc.ingest('u1', legacy(DataWipeStatus.FAILED));
    await svc.ingest('u1', legacy(DataWipeStatus.WIPED));
    expect(assets[0].auditStatus).toBe(AssetAuditStatus.DATA_WIPE_FAILED);
    // A re-capture (no wipe) settles nothing.
    await svc.ingest('u1', { profile, auditKind: 'amazon' });
    expect(assets[0].auditStatus).toBe(AssetAuditStatus.DATA_WIPE_FAILED);
    // The failure is now two days old on both clocks; a new wipe clears it.
    const old = new Date(Date.UTC(2026, 8, 17, 10));
    audits[0].createdAt = old;
    audits[1].createdAt = old;
    await svc.ingest('u1', legacy(DataWipeStatus.WIPED));
    expect(assets[0].auditStatus).toBe(AssetAuditStatus.DATA_WIPED);
  });

  // Cross-check, wave 2: settling runs AFTER the wipe record is committed.
  // If it threw (a DB error taking the lock), the stick got a 500, retried,
  // and filed the same wipe again on every retry - with the history and
  // activity entries skipped. Like issueCertificate, it is now never fatal;
  // the next wipe filed for the machine settles it, and the certificate
  // routes decide from the records themselves, not from this status.
  it('a failure while settling does not turn a filed wipe into a 500', async () => {
    const { svc, assets, audits } = ingestHarness();
    await svc.ingest('u1', { profile, auditKind: 'amazon' });
    const repo = (svc as unknown as { assets: { manager: unknown } }).assets;
    repo.manager = {
      transaction: () => Promise.reject(new Error('could not obtain lock')),
    };
    const out = await svc.ingest('u1', wipe('S-A', DataWipeStatus.WIPED));
    expect(out.assetId).toBe(assets[0].id);
    expect(audits).toHaveLength(2);
    expect(assets[0].auditStatus).toBe(AssetAuditStatus.POWER_ON);
  });

  it('the audit row still records what this one event established', async () => {
    const { svc, audits } = ingestHarness();
    await svc.ingest('u1', wipe('S-A', DataWipeStatus.WIPED));
    expect(audits[0].auditStatus).toBe(AssetAuditStatus.DATA_WIPED);
  });
});
