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
        await repo.upsert({ ...entry.data, id: entry.id }, ['id']);
        if (entry.table === 'asset_audits') {
          await this.applyAuditSideEffects(entry, userId);
        }
        break;
      case 'PATCH':
        await repo.update({ id: entry.id }, entry.data ?? {});
        break;
      case 'DELETE':
        await repo.delete({ id: entry.id });
        break;
      default:
        throw new BadRequestException(`Unsupported op: ${entry.op}`);
    }
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
