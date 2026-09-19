import { BadRequestException } from '@nestjs/common';
import { DataWipeStatus } from '../assets/asset-audit.entity';
import type { AssetAudit } from '../assets/asset-audit.entity';
import { CertificatesService } from '../assets/certificates.service';
import { IngestAuditDto } from './dto/ingest-audit.dto';
import { ingestHarness } from './ingest-harness-for-spec';
import { LOTLESS_WIPE_NOTE, LOTLESS_WIPE_NOTE_HELD } from './devices.service';

// Incident, 2026-09-19: a station account holding BOTH audit permissions
// sends no auditKind until the operator picks Amazon or Goods In, and the
// station let an NVMe drive be erased before that. The erase was real
// (crypto sanitize, read back clean), but ingest answered 400 "No audit lot
// selected", the stick queued the record and retried it forever, and nobody
// was told. A wipe that physically happened must be on record: it is now
// filed with no lot, and says so. A capture with no lot keeps its 400.

// The exact shape of the record stuck in the stick's queue: no auditKind,
// no lotId.
const STUCK = {
  profile: {
    identification: {
      manufacturer: 'Dell Inc.',
      model: 'Latitude 5420',
      serialNumber: 'DELL123',
    },
    storage: [
      {
        serialNumber: 'S6XNNS0T123456',
        model: 'Samsung PM9A1',
        capacity: '512GB',
        type: 'NVMe',
      },
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
  wipeStartedAt: '2026-09-19T09:58:00Z',
  wipedAt: '2026-09-19T09:59:12Z',
  wipedAtClock: 'network',
  wipedDrive: {
    serialNumber: 'S6XNNS0T123456',
    model: 'Samsung PM9A1',
    sizeBytes: 512110190592,
    transport: 'nvme',
    rotational: false,
    devicePath: '/dev/nvme0n1',
  },
} as unknown as IngestAuditDto;

const CAPTURE_ONLY = {
  profile: STUCK.profile,
} as unknown as IngestAuditDto;

// The certificate service over what the harness stored: the asset as the
// harness holds it (batchId null for a lotless device) and its rows.
function certificatesOver(
  asset: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
) {
  const qb = {
    addSelect: () => qb,
    where: () => qb,
    getOne: () => Promise.resolve({ hardwareProfile: null, ...asset }),
  };
  return new CertificatesService(
    { createQueryBuilder: () => qb } as never,
    { find: () => Promise.resolve(rows as unknown as AssetAudit[]) } as never,
    {} as never,
  );
}

describe('a station wipe that names no lot (incident 2026-09-19)', () => {
  it('replays the exact stuck payload: accepted, filed with no lot, and said so', async () => {
    const { svc, assets, audits, history } = ingestHarness({
      activeLotId: null,
    });
    await expect(svc.ingest('u1', STUCK)).resolves.toMatchObject({
      created: true,
      tag: 'DELL123',
      lot: null,
    });
    expect(assets).toHaveLength(1);
    expect(assets[0].batchId).toBeNull();
    expect(assets[0].lotId).toBeNull();
    expect(audits).toHaveLength(1);
    // auditKind kept as sent: none.
    expect(audits[0].auditKind).toBeNull();
    expect(audits[0].dataWipeStatus).toBe(DataWipeStatus.WIPED);
    expect(audits[0].sanitisationLevel).toBe('purge');
    expect(audits[0].wipeVerification).toBe('clean');
    expect(audits[0].wipedDriveSerial).toBe('S6XNNS0T123456');
    expect(audits[0].wipeSource).toBe('station');
    expect(audits[0].notes).toContain(LOTLESS_WIPE_NOTE);
    expect(history).toHaveLength(1);
    expect(history[0].notes).toBe(LOTLESS_WIPE_NOTE);
    // The per-drive roll-up settled the machine as wiped.
    expect(assets[0].auditStatus).toBe('data_wiped');
  });

  it('a lotless wiped machine is certificate-eligible, and its certificate renders', async () => {
    const { svc, assets, audits } = ingestHarness({ activeLotId: null });
    await svc.ingest('u1', STUCK);
    const certs = certificatesOver(assets[0], audits);
    const answer = await certs.eligibility(assets[0].id);
    expect(answer).toMatchObject({
      available: true,
      reason: null,
      verdict: 'wiped',
    });
    const { buffer, filename } = await certs.erasureCertificate(assets[0].id);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(filename).toBe('erasure-certificate-DELL123.pdf');
  });

  it('a lotless FAILED wipe is also on record (201), and not certifiable', async () => {
    const { svc, assets, audits } = ingestHarness({ activeLotId: null });
    const failed = {
      ...STUCK,
      dataWipeStatus: 'failed',
      verification: 'found',
    } as unknown as IngestAuditDto;
    await expect(svc.ingest('u1', failed)).resolves.toMatchObject({
      lot: null,
    });
    expect(assets[0].batchId).toBeNull();
    expect(audits[0].notes).toContain(LOTLESS_WIPE_NOTE);
    expect(assets[0].auditStatus).toBe('data_wipe_failed');
    const answer = await certificatesOver(assets[0], audits).eligibility(
      assets[0].id,
    );
    expect(answer.available).toBe(false);
  });

  it('with an active lot, the same payload files into that lot exactly as before', async () => {
    const { svc, assets, audits, history } = ingestHarness(); // active LOT-1
    await expect(svc.ingest('u1', STUCK)).resolves.toMatchObject({
      lot: 'LOT-1',
    });
    expect(assets[0].batchId).toBe('lot-1');
    expect(audits[0].notes).toBeNull();
    expect(history[0].notes).toBe('Hardware audit captured into LOT-1');
  });

  it('a payload lotId still wins over no active lot', async () => {
    const { svc, assets, audits } = ingestHarness({ activeLotId: null });
    await expect(
      svc.ingest('u1', { ...STUCK, lotId: 'lot-2' }),
    ).resolves.toMatchObject({ lot: 'LOT-2' });
    expect(assets[0].batchId).toBe('lot-2');
    expect(audits[0].notes).toBeNull();
  });

  it('a capture-only payload with no lot is still a 400', async () => {
    const { svc, assets, audits } = ingestHarness({ activeLotId: null });
    await expect(svc.ingest('u1', CAPTURE_ONLY)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.ingest('u1', CAPTURE_ONLY)).rejects.toThrow(
      'No audit lot selected',
    );
    expect(assets).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('a manual add with a wipe status and no lot is still a 400 (a person can pick one)', async () => {
    const { svc } = ingestHarness({ activeLotId: null });
    await expect(
      svc.ingest('u1', { ...STUCK, manual: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never takes a known device OUT of its lot: it stays there and the note names it', async () => {
    // First captured into LOT-2 (payload lotId), then its wipe arrives with
    // no lot from an account with no active lot.
    const { svc, assets, audits, history } = ingestHarness({
      activeLotId: null,
    });
    await svc.ingest('u1', {
      ...CAPTURE_ONLY,
      lotId: 'lot-2',
    });
    expect(assets[0].batchId).toBe('lot-2');
    await expect(svc.ingest('u1', STUCK)).resolves.toMatchObject({
      created: false,
      lot: null,
    });
    expect(assets).toHaveLength(1);
    expect(assets[0].batchId).toBe('lot-2');
    const note = `${LOTLESS_WIPE_NOTE_HELD} LOT-2 - check that is right.`;
    expect(audits[1].notes).toBe(note);
    expect(history[1].notes).toBe(note);
  });
});
