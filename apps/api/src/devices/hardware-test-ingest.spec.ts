import { IngestAuditDto } from './dto/ingest-audit.dto';
import { ingestHarness } from './ingest-harness-for-spec';

// Contract C6, the API's half of the re-audit hazard: "the station must carry
// hardwareTest forward across a rescan, AND the API must not drop it when a new
// profile arrives for the same audit."
//
// ingest() replaces the asset's hardware_profile wholesale on every record, and
// the hardware test rides INSIDE that column (no migration, no new column). The
// station cannot protect it - its copy lives in one process's memory on a live
// USB - so a machine tested on Monday and re-audited on Wednesday lost the test
// from the asset page, the Reports column and the report view. The previous
// value exists only here, which makes this the only place it can be kept.

const TEST = {
  status: 'PASSED',
  completed: 4,
  total: 4,
  technician: 'Ann Operator',
  testedAt: '2026-09-20T12:00:00Z',
  clockWasNetwork: true,
  speaker: { status: 'PASSED', reason: null, action: null, notes: '' },
  keyboard: { status: 'PASSED', reason: null, action: null, notes: '' },
  camera: { status: 'PASSED', reason: null, action: null, notes: '' },
  screen: { status: 'PASSED', reason: null, action: null, notes: '' },
  history: [],
};

const payload = (extra: Record<string, unknown> = {}) => ({
  lotId: 'lot-1',
  profile: {
    identification: {
      manufacturer: 'Dell Inc.',
      model: 'Latitude 7490',
      serialNumber: 'HOST1',
    },
    storage: [{ serialNumber: 'S1', capacity: '256GB', type: 'NVMe' }],
    ...extra,
  },
});

type Stored = { hardwareTest?: unknown; identification?: unknown };

describe('the hardware test on re-ingest (contract C6)', () => {
  it('survives a later record that carries no test of its own', async () => {
    const { svc, assets, audits } = ingestHarness();
    await svc.ingest(
      'u1',
      payload({ hardwareTest: TEST }) as unknown as IngestAuditDto,
    );
    expect((assets[0].hardwareProfile as Stored).hardwareTest).toEqual(TEST);

    // Wednesday: the same machine, a fresh station boot. Nothing in this
    // payload knows a hardware test was ever run.
    await svc.ingest('u1', payload() as unknown as IngestAuditDto);
    expect(assets).toHaveLength(1);
    expect((assets[0].hardwareProfile as Stored).hardwareTest).toEqual(TEST);
    // The rest of the profile is still the newest capture's, not the old one's.
    expect((assets[0].hardwareProfile as Stored).identification).toEqual(
      payload().profile.identification,
    );
    // The audit row is this event's own snapshot and is left alone: it records
    // what the capture that made it actually carried.
    expect((audits[1].hardwareProfile as Stored).hardwareTest).toBeUndefined();
  });

  it('a newer test in the payload replaces the stored one', async () => {
    const { svc, assets } = ingestHarness();
    await svc.ingest(
      'u1',
      payload({ hardwareTest: TEST }) as unknown as IngestAuditDto,
    );
    const retest = { ...TEST, status: 'FAILED', technician: 'Bea Signed-In' };
    await svc.ingest(
      'u1',
      payload({ hardwareTest: retest }) as unknown as IngestAuditDto,
    );
    expect((assets[0].hardwareProfile as Stored).hardwareTest).toEqual(retest);
  });

  it('adds nothing when no test has ever been stored', async () => {
    const { svc, assets } = ingestHarness();
    await svc.ingest('u1', payload() as unknown as IngestAuditDto);
    await svc.ingest('u1', payload() as unknown as IngestAuditDto);
    expect(assets[0].hardwareProfile as Stored).not.toHaveProperty(
      'hardwareTest',
    );
  });
});
