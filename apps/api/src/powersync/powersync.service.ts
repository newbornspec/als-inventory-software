import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { AssetEventType, AssetHistory } from '../assets/asset-history.entity';
import { AssetAudit } from '../assets/asset-audit.entity';

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
  ) {}

  async applyBatch(batch: CrudEntry[], userId: string): Promise<void> {
    for (const entry of batch) {
      await this.applyOne(entry, userId);
    }
  }

  private async applyOne(entry: CrudEntry, userId: string): Promise<void> {
    const repo = this.repoFor(entry.table);

    switch (entry.op) {
      case 'PUT':
        // Upsert: covers both "new asset created offline" and first-sync of an update.
        await repo.upsert({ ...this.toEntityData(entry.data), id: entry.id }, ['id']);
        if (entry.table === 'asset_audits') {
          // Reads the original snake_case data — unchanged by the mapping above.
          await this.applyAuditSideEffects(entry, userId);
        }
        break;
      case 'PATCH':
        await repo.update({ id: entry.id }, this.toEntityData(entry.data));
        break;
      case 'DELETE':
        await repo.delete({ id: entry.id });
        break;
      default:
        throw new BadRequestException(`Unsupported op: ${entry.op}`);
    }
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
