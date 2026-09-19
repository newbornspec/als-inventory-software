import { DataWipeStatus } from '../assets/asset-audit.entity';
import type { IngestAuditDto } from './dto/ingest-audit.dto';
import { hostTag, usableBiosUuid } from './host-identity';
import { ingestHarness } from './ingest-harness-for-spec';

// Remediation spec D-6, owner decision D24: a machine with no serial became a
// new asset for every drive it wiped.

const UUID = '4c4c4544-0042-3510-8052-b4c04f4e3132';

describe('usableBiosUuid', () => {
  it('accepts a real UUID, upper-cased so the tag reads one way', () => {
    expect(usableBiosUuid(UUID)).toBe(UUID.toUpperCase());
    expect(usableBiosUuid(`  ${UUID.toUpperCase()} `)).toBe(UUID.toUpperCase());
  });

  it('ignores firmware placeholders that thousands of boards share', () => {
    for (const junk of [
      '00000000-0000-0000-0000-000000000000',
      'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
      '03000200-0400-0500-0006-000700080009',
    ]) {
      expect(usableBiosUuid(junk)).toBeNull();
    }
  });

  it('ignores anything that is not a UUID', () => {
    for (const bad of ['', 'Not Settable', '1234', null, undefined, 42]) {
      expect(usableBiosUuid(bad)).toBeNull();
    }
  });
});

describe('hostTag', () => {
  it('a serial always wins', () => {
    expect(hostTag('ABC1234', UUID)).toBe('ABC1234');
  });
  it('no serial: the system UUID', () => {
    expect(hostTag(null, UUID)).toBe(`UUID-${UUID.toUpperCase()}`);
  });
  it('neither: no identity (the caller keeps HW-<timestamp>)', () => {
    expect(hostTag(null, undefined)).toBeNull();
    expect(hostTag(null, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('ingest: a machine with no serial', () => {
  const wipe = (biosUuid: string | undefined, drive: string) =>
    ({
      profile: {
        identification: {
          manufacturer: 'Generic',
          model: 'Tower',
          serialNumber: '',
          ...(biosUuid ? { biosUuid } : {}),
        },
      },
      dataWipeStatus: DataWipeStatus.WIPED,
      dataWipeMethod: 'Overwrite — single zero pass (NIST Clear)',
      wipedDrive: { serialNumber: drive },
    }) as IngestAuditDto;

  it('two wipe payloads with a blank serial and the same UUID land on one asset', async () => {
    const { svc, assets, audits } = ingestHarness();
    const first = await svc.ingest('u1', wipe(UUID, 'DRIVE-A'));
    // Same machine, second drive - the UUID as another dmidecode spells it.
    const second = await svc.ingest('u1', wipe(UUID.toUpperCase(), 'DRIVE-B'));
    expect(assets).toHaveLength(1);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.assetId).toBe(first.assetId);
    expect(first.tag).toBe(`UUID-${UUID.toUpperCase()}`);
    expect(audits.map((a) => a.assetId)).toEqual([
      first.assetId,
      first.assetId,
    ]);
    expect(audits.map((a) => a.wipedDriveSerial)).toEqual([
      'DRIVE-A',
      'DRIVE-B',
    ]);
  });

  it('different UUIDs stay different machines', async () => {
    const { svc, assets } = ingestHarness();
    await svc.ingest('u1', wipe(UUID, 'DRIVE-A'));
    await svc.ingest(
      'u1',
      wipe('4c4c4544-0042-3510-8052-b4c04f4e9999', 'DRIVE-B'),
    );
    expect(assets).toHaveLength(2);
  });

  it("with neither serial nor UUID, keeps today's behaviour (a new HW- asset)", async () => {
    const { svc, assets } = ingestHarness();
    const r = await svc.ingest('u1', wipe(undefined, 'DRIVE-A'));
    expect(r.tag).toMatch(/^HW-\d+$/);
    expect(assets).toHaveLength(1);
  });

  it('a machine with a serial is still keyed on the serial', async () => {
    const { svc } = ingestHarness();
    const dto = wipe(UUID, 'DRIVE-A');
    dto.profile!.identification!.serialNumber = 'ABC1234';
    expect((await svc.ingest('u1', dto)).tag).toBe('ABC1234');
  });
});
