import { FindOperator } from 'typeorm';
import { UserRole } from '../users/user.entity';
import { AssetAudit } from '../assets/asset-audit.entity';
import { DevicesService } from './devices.service';

// An in-memory DevicesService for ingest specs: just enough of each
// repository for ingest() to run end to end, recording what it saved.
// Not a spec itself (jest runs only *.spec.ts), so both ingest specs share it;
// the name ends in "spec.ts" so tsconfig.build.json keeps it out of dist.

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
      // createdAt as the database would stamp it, strictly increasing so
      // "latest" is well defined for the wipe roll-up.
      const saved = {
        id: `audit-${++seq}`,
        createdAt: new Date(Date.UTC(2026, 8, 19, 10, 0, audits.length)),
        ...a,
      };
      audits.push(saved);
      return Promise.resolve(saved);
    },
    // settleWipeStatus's read: this asset's rows with a wipe outcome.
    find: ({
      where,
    }: {
      where: { assetId: string; dataWipeStatus: FindOperator<string[]> };
    }) =>
      Promise.resolve(
        audits.filter(
          (a) =>
            a.assetId === where.assetId &&
            where.dataWipeStatus.value.includes(a.dataWipeStatus as string),
        ),
      ),
  };

  // settleWipeStatus runs in a transaction that locks the asset row. The lock
  // itself is proven against real Postgres (wipe-settle.pg-spec); here it is
  // enough that the same repositories answer inside it.
  const lockedAssetQb = () => {
    let id = '';
    const qb = {
      setLock: () => qb,
      where: (_sql: string, params: { id: string }) => {
        id = params.id;
        return qb;
      },
      getOne: () => Promise.resolve(assets.find((a) => a.id === id) ?? null),
    };
    return qb;
  };
  const txManager = {
    getRepository: (entity: unknown) =>
      entity === AssetAudit
        ? auditRepo
        : { ...assetRepo, createQueryBuilder: lockedAssetQb },
  };
  (assetRepo as Record<string, unknown>).manager = {
    transaction: (cb: (m: typeof txManager) => Promise<unknown>) =>
      cb(txManager),
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
