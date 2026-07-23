import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { AssetEventType, AssetHistory } from '../assets/asset-history.entity';
import { AssetAudit } from '../assets/asset-audit.entity';
import { Batch } from '../batches/batch.entity';
import { isScopedManager, managerCanAccessBatch, type RequestUser } from '../common/ownership';

interface CrudEntry {
  op: 'PUT' | 'PATCH' | 'DELETE';
  table: string;
  id: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class PowerSyncService {
  constructor(
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetHistory) private history: Repository<AssetHistory>,
    @InjectRepository(AssetAudit) private audits: Repository<AssetAudit>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
  ) {}

  async applyBatch(batch: CrudEntry[], user: RequestUser): Promise<void> {
    for (const entry of batch) {
      await this.applyOne(entry, user);
    }
  }

  private async applyOne(entry: CrudEntry, user: RequestUser): Promise<void> {
    // Defence-in-depth: a scoped manager's device only holds their own lots'
    // rows (see powersync/sync-rules.yaml), but block a tampered client from
    // pushing a write to an asset/lot they don't own.
    await this.assertManagerMayWrite(entry, user);
    const userId = user.userId;
    const repo = this.repoFor(entry.table);
    let data = this.toEntityData(entry.data);

    // An offline client can hold writes that reference a batch/lot/product the
    // server deleted in the meantime. Uploading such a row fails a foreign-key
    // constraint, and because PowerSync retries the whole batch, that one bad
    // reference permanently wedges the client's upload queue — every later
    // write is stuck behind it and never syncs. Null the dangling reference so
    // the row still lands and the queue keeps draining.
    if (entry.table === 'assets') data = await this.sanitizeAssetFks(data);

    switch (entry.op) {
      case 'PUT':
        // Upsert: covers both "new asset created offline" and first-sync of an update.
        await repo.upsert({ ...data, id: entry.id }, ['id']);
        if (entry.table === 'asset_audits') {
          // Reads the original snake_case data — unchanged by the mapping above.
          await this.applyAuditSideEffects(entry, userId);
        }
        break;
      case 'PATCH':
        await repo.update({ id: entry.id }, data);
        break;
      case 'DELETE':
        await repo.delete({ id: entry.id });
        break;
      default:
        throw new BadRequestException(`Unsupported op: ${entry.op}`);
    }
  }

  // Reject an offline write from a scoped manager that targets an asset/lot they
  // don't own. No-op for admins/technicians. Kept lenient where ownership can't
  // be determined (e.g. a child row whose asset hasn't been applied yet) so a
  // legitimate offline batch never wedges the upload queue.
  private async assertManagerMayWrite(entry: CrudEntry, user: RequestUser): Promise<void> {
    if (!isScopedManager(user)) return;
    const owns = (batchId: unknown): Promise<boolean> =>
      managerCanAccessBatch(this.batches, typeof batchId === 'string' ? batchId : null, user);

    if (entry.table === 'assets') {
      const existing = await this.assets.findOne({
        where: { id: entry.id },
        select: { id: true, batchId: true },
      });
      // Can't touch an asset already filed in a lot you don't own.
      if (existing && !(await owns(existing.batchId))) {
        throw new ForbiddenException('You do not own this asset.');
      }
      if (entry.op !== 'DELETE') {
        const incoming = entry.data?.batch_id ?? entry.data?.batchId;
        if (incoming != null) {
          // Placing/keeping it in a lot — must be one you own.
          if (!(await owns(incoming))) throw new ForbiddenException('You do not own that lot.');
        } else if (!existing) {
          // A brand-new asset with no lot: a manager must receive into their own.
          throw new ForbiddenException('A lot you own is required.');
        }
      }
    } else if (entry.table === 'asset_history' || entry.table === 'asset_audits') {
      const assetId = (entry.data?.asset_id ?? entry.data?.assetId) as string | undefined;
      if (assetId) {
        const a = await this.assets.findOne({ where: { id: assetId }, select: { batchId: true } });
        // Only block when the asset exists and isn't theirs; if it isn't applied
        // yet, the guarded asset write in the same batch already covers it.
        if (a && !(await owns(a.batchId))) {
          throw new ForbiddenException('You do not own this asset.');
        }
      }
    }
  }

  // Replace any asset foreign-key that points at a row which no longer exists
  // with null, so a stale offline reference can't fail (and wedge) the upload.
  private async sanitizeAssetFks(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const fkTables: Record<string, string> = {
      batchId: 'batches',
      lotId: 'lots',
      productId: 'products',
      locationId: 'locations',
      ownerId: 'users',
    };
    for (const [key, table] of Object.entries(fkTables)) {
      const value = data[key];
      if (typeof value === 'string' && value.length > 0) {
        const rows: unknown[] = await this.assets.manager.query(
          `SELECT 1 FROM "${table}" WHERE id = $1 LIMIT 1`,
          [value],
        );
        if (rows.length === 0) data[key] = null;
      }
    }
    return data;
  }

  // PowerSync sends column values keyed by the local SQLite schema's snake_case
  // names (batch_id, stock_status, serial_number …), but TypeORM's upsert/update
  // map by the entity's camelCase property names. Without translating, every
  // multi-word column is silently dropped server-side (an offline scan into a
  // lot would never persist batch_id, an offline audit would lose serial_number,
  // ram_gb, cosmetic_grade, and so on). Convert the keys so the write lands.
  private toEntityData(data?: Record<string, unknown>): Record<string, unknown> {
    if (!data) return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = value;
    }
    // functional_tests syncs as a JSON string (SQLite has no JSON type); the
    // server column is jsonb, so parse it back to an object before saving.
    if (typeof out.functionalTests === 'string') {
      try {
        out.functionalTests = JSON.parse(out.functionalTests);
      } catch {
        /* not valid JSON — leave as-is rather than fail the whole upload */
      }
    }
    return out;
  }

  // PowerSync writes go straight to the table via upsert() above, bypassing
  // AssetsService.createAudit() entirely — so an audit recorded offline
  // (no signal, in a warehouse) needs the same side effects replicated here:
  // denormalizing the grade/audit outcome onto the parent asset and logging
  // the history event. Without this, an offline audit would silently differ
  // in behavior from the same action taken online.
  private async applyAuditSideEffects(entry: CrudEntry, userId: string): Promise<void> {
    const data = entry.data ?? {};
    const assetId = data.asset_id as string | undefined;
    if (!assetId) return;

    const patch: Record<string, unknown> = {};
    if (data.cosmetic_grade) patch.conditionGrade = data.cosmetic_grade;
    if (data.audit_status) patch.auditStatus = data.audit_status;
    if (Object.keys(patch).length > 0) {
      await this.assets.update({ id: assetId }, patch);
    }

    await this.history.save(
      this.history.create({
        assetId,
        eventType: AssetEventType.AUDITED,
        userId,
        notes: data.final_disposition
          ? `Audit recorded offline — disposition: ${data.final_disposition}`
          : 'Audit recorded offline',
      }),
    );
  }

  // Tables offline clients are allowed to write to via the sync upload
  // endpoint. Keep this narrow — it's the server-side boundary that stops a
  // compromised or buggy client from writing to arbitrary tables (e.g. users,
  // locations). asset_audits was added here specifically so a technician can
  // record a full ITAD audit with zero signal in a warehouse.
  private repoFor(table: string): Repository<any> {
    if (table === 'assets') return this.assets;
    if (table === 'asset_history') return this.history;
    if (table === 'asset_audits') return this.audits;
    throw new BadRequestException(`Table "${table}" is not syncable`);
  }
}
