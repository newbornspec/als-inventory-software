import { ValidationPipe } from '@nestjs/common';
import { IngestAuditDto } from './dto/ingest-audit.dto';
import { ingestHarness } from './ingest-harness-for-spec';

// Contract C5: the station computes each drive's health ONCE and the API must
// store it exactly as sent - no migration (the profile is JSONB), no
// re-derivation, no stripping by the global whitelist pipe. Run through the
// same ValidationPipe options main.ts installs, then ingest end to end.

const HEALTH = {
  measured: true,
  percent: 94,
  status: 'good',
  basis: 'life remaining 94% reported by the drive',
  reasons: [],
  source: 'nvme',
  smartPassed: true,
  temperatureC: 36,
  powerOnHours: 5678,
  powerCycles: 812,
  lifeUsedPct: 6,
  availableSparePct: 100,
  reallocatedSectors: null,
  pendingSectors: null,
  uncorrectableSectors: null,
  mediaErrors: 0,
  criticalWarning: 0,
  selfTest: 'passed',
  tool: 'smartctl 7.4',
};
const NOT_MEASURABLE = {
  measured: false,
  reason: 'behind a RAID/Intel RST controller',
  action: 'set the storage mode to AHCI in the BIOS, then press Rescan',
  source: 'ata-hdd',
};

const PAYLOAD = {
  profile: {
    identification: {
      manufacturer: 'Dell Inc.',
      model: 'Latitude 5420',
      serialNumber: 'DELL123',
    },
    storage: [
      {
        serialNumber: 'S1',
        model: 'Samsung SSD 980',
        capacity: '500GB',
        type: 'NVMe',
        health: HEALTH,
      },
      {
        serialNumber: 'S2',
        model: 'WDC WD10EZEX',
        capacity: '1TB',
        type: 'HDD',
        health: NOT_MEASURABLE,
      },
    ],
  },
};

describe('drive health on ingest (contract C5)', () => {
  it('is stored untouched on the asset and on the audit snapshot', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const dto = (await pipe.transform(structuredClone(PAYLOAD), {
      type: 'body',
      metatype: IngestAuditDto,
    })) as IngestAuditDto;
    const { svc, assets, audits } = ingestHarness();
    await svc.ingest('u1', dto);

    type Stored = { storage: Array<{ health: unknown }> };
    const onAsset = assets[0].hardwareProfile as Stored;
    const onAudit = audits[0].hardwareProfile as Stored;
    for (const p of [onAsset, onAudit]) {
      expect(p.storage[0].health).toEqual(HEALTH);
      expect(p.storage[1].health).toEqual(NOT_MEASURABLE);
    }
  });

  it('an old profile with no health still ingests exactly as before', async () => {
    const { svc, assets } = ingestHarness();
    const old = structuredClone(PAYLOAD);
    for (const d of old.profile.storage)
      delete (d as { health?: unknown }).health;
    await svc.ingest('u1', old as unknown as IngestAuditDto);
    const stored = assets[0].hardwareProfile as {
      storage: Array<Record<string, unknown>>;
    };
    expect(stored.storage[0]).not.toHaveProperty('health');
    expect(stored.storage).toHaveLength(2);
  });
});
