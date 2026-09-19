import { UserRole } from '../users/user.entity';
import { DevicesService } from './devices.service';

// An in-memory DevicesService for ingest specs: just enough of each
// repository for ingest() to run end to end, recording what it saved.
// Not a spec itself (no .spec suffix) so it can be shared.

export interface StoredAsset {
  id: string;
  tag: string;
  [key: string]: unknown;
}

export function ingestHarness() {
  const assets: StoredAsset[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let seq = 0;

  // The only query ingest() builds on assets: LOWER(a.tag) = LOWER(:tag).
  const assetQb = () => {
    let tag = '';
    const qb = {
      where: (_sql: string, params: { tag: string }) => {
        tag = params.tag;
        return qb;
      },
      getOne: () =>
        Promise.resolve(
          assets.find((a) => a.tag.toLowerCase() === tag.toLowerCase()) ?? null,
        ),
    };
    return qb;
  };

  const assetRepo = {
    createQueryBuilder: assetQb,
    create: (a: Record<string, unknown>) => ({ ...a }),
    save: (a: Record<string, unknown>) => {
      const saved = { ...a, id: `asset-${++seq}` } as StoredAsset;
      assets.push(saved);
      return Promise.resolve(saved);
    },
    update: (id: string, patch: Record<string, unknown>) => {
      const a = assets.find((x) => x.id === id);
      if (a) Object.assign(a, patch);
      return Promise.resolve();
    },
    // nextUnitId's sequence.
    query: () => Promise.resolve([{ n: ++seq }]),
  };

  const auditRepo = {
    create: (a: Record<string, unknown>) => ({ ...a }),
    save: (a: Record<string, unknown>) => {
      audits.push(a);
      return Promise.resolve(a);
    },
  };

  const passthrough = {
    create: (a: unknown) => a,
    save: (a: unknown) => Promise.resolve(a),
  };

  const svc = new DevicesService(
    {
      findOne: () => Promise.resolve({ id: 'u1', activeAuditLotId: 'lot-1' }),
    } as never,
    {
      findOne: () => Promise.resolve({ id: 'lot-1', batchNumber: 'LOT-1' }),
    } as never,
    assetRepo as never,
    auditRepo as never,
    passthrough as never,
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

  return { svc, assets, audits };
}
