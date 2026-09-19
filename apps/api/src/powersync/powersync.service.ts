import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { AssetEventType, AssetHistory } from '../assets/asset-history.entity';
import { AssetAudit } from '../assets/asset-audit.entity';
import { Batch } from '../batches/batch.entity';
import { isScopedManager, managerCanAccessBatch, type RequestUser } from '../common/ownership';
import { PermissionsService } from '../auth/permissions.service';
import { AUDIT_PERMISSIONS, holds, mayRecordManualWipe } from '../assets/manual-wipe';

// The ONLY columns an offline client may write, per table: exactly what the
// web/phone client schema holds (apps/web/lib/powersync/schema.ts), minus the
// columns the server owns. Everything else a client sends is dropped.
//
// An allow-list, not a block-list, because the block-list was bypassed three
// ways in review: camelCase spellings (dataWipeStatus, wipeSource, auditedById)
// sailed past checks written for snake_case, because toEntityData only rewrites
// keys that contain '_x'; relation objects (auditedBy: {id}) won over the
// author the server set; and mixed spellings (data_wipeStatus) normalised into
// columns nobody checked. A tampered technician client could file a
// station-worded "Wiped" record, credit it to a colleague, and date it 2099 so
// it stayed the latest wipe forever. Only real column names from the client
// schema survive now, so the snake_case checks below see every claim.
//
// Server-owned and therefore absent: hardware_profile (the certificate's drive
// list), wipe_source (provenance), audited_by_id / user_id (the author is
// whoever is signed in), id (from the entry), and on assets owner_id (online it
// needs manage_ownership; no client writes it).
const SYNC_WRITABLE: Record<string, ReadonlySet<string>> = {
  assets: new Set([
    'tag', 'name', 'category', 'stock_status', 'condition_grade', 'audit_status',
    'location_id', 'image_url', 'batch_id', 'lot_id', 'updated_at',
  ]),
  asset_history: new Set(['asset_id', 'event_type', 'notes', 'created_at']),
  asset_audits: new Set([
    'asset_id', 'audit_status', 'audit_kind', 'operator_name', 'restore_image_status',
    'restore_image_name', 'manufacturer', 'model', 'serial_number', 'cpu', 'ram_gb',
    'storage_capacity', 'screen_size', 'screen_resolution', 'battery_health',
    'cosmetic_grade', 'functional_tests', 'bios_locked', 'charger_included',
    'data_wipe_status', 'data_wipe_method', 'final_disposition', 'notes', 'created_at',
  ]),
};

// A device's identity - what the certificate prints as tag, model and type -
// is fixed once it exists. No client of ours changes these after creation (the
// scan page only moves batch_id; the audit form only grade and status), so a
// write that would is dropped. Without this, any account could move a genuine
// wipe onto a machine that was never wiped by relabelling it.
const ASSET_IDENTITY = new Set(['tag', 'name', 'category']);

// A client's created_at is kept only if it is a real time no later than a few
// minutes from now. A future date pins a row as "the latest wipe" for good; the
// offline form's own timestamp (when the audit was actually recorded) is kept.
// SQLite's datetime('now') has no zone and is UTC, so it is read as UTC.
const FUTURE_TOLERANCE_MS = 5 * 60_000;
export function acceptableCreatedAt(v: unknown, now = Date.now()): boolean {
  if (typeof v !== 'string') return false;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(' ', 'T')}Z` : v;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t <= now + FUTURE_TOLERANCE_MS;
}

interface CrudEntry {
  op: 'PUT' | 'PATCH' | 'DELETE';
  table: string;
  id: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class PowerSyncService {
  private readonly logger = new Logger(PowerSyncService.name);

  constructor(
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetHistory) private history: Repository<AssetHistory>,
    @InjectRepository(AssetAudit) private audits: Repository<AssetAudit>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
    private permissions: PermissionsService,
  ) {}

  async applyBatch(batch: CrudEntry[], user: RequestUser): Promise<void> {
    for (const entry of batch) {
      await this.applyOne(entry, user);
    }
  }

  private async applyOne(incoming: CrudEntry, user: RequestUser): Promise<void> {
    // Defence-in-depth: a scoped manager's device only holds their own lots'
    // rows (see powersync/sync-rules.yaml), but block a tampered client from
    // pushing a write to an asset/lot they don't own.
    await this.assertManagerMayWrite(incoming, user);

    const screened = await this.screen(incoming, user);
    if (screened.skip !== undefined) {
      this.logger.warn(
        `sync: skipped ${incoming.op} ${incoming.table}/${incoming.id} from user ${user.userId} - ${screened.skip}`,
      );
      return;
    }
    const entry = screened.entry;
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
        // Attribute an offline audit to the person who recorded it. The offline
        // audit form's INSERT carries no audited_by_id (the client doesn't know
        // its own user id — see audit-form.tsx), so before this every audit
        // recorded offline landed with a NULL author, permanently. The uploader
        // IS the author: a PowerSync upload rides the recording user's own JWT.
        // Filling it in here also repairs rows from older clients as they sync.
        // ALWAYS the uploader: screen() discards any author the client sends,
        // because naming someone else as the author of a wipe record is
        // impersonation, and no client of ours has ever sent one.
        if (entry.table === 'asset_audits' && data.auditedById == null) {
          data = { ...data, auditedById: userId };
        }
        if (entry.table === 'asset_audits') {
          // The audit and its side effects (the device's grade and status, the
          // AUDITED history event) land together or not at all. screen() skips a
          // PUT whose row already exists - that is what makes a retried upload
          // harmless - so if they were separate, a failure between the insert
          // and the side effects would leave the retry nothing to do and the
          // side effects lost for good. ON CONFLICT DO NOTHING covers two
          // uploads of the same audit racing past screen()'s check.
          await this.audits.manager.transaction(async (m) => {
            const res = await m
              .createQueryBuilder()
              .insert()
              .into(AssetAudit)
              .values({ ...data, id: entry.id })
              .orIgnore()
              .returning('id')
              .execute();
            if (!res.raw?.length) return; // it had already landed
            // Reads the screened snake_case data - see screen().
            await this.applyAuditSideEffects(entry, userId, m);
          });
          break;
        }
        // Upsert: covers both "new asset created offline" and first-sync of an update.
        await repo.upsert({ ...data, id: entry.id }, ['id']);
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

  // What an offline client may do to the records a certificate is built from.
  //
  // Returns the entry to apply - possibly with a claim or a server-owned column
  // removed - or a reason to SKIP it. It never throws: PowerSync retries the
  // whole batch on an error, so one refused write would wedge that device's
  // upload queue for good (the same reason sanitizeAssetFks nulls instead of
  // throwing). Every skip is logged, so a refusal is visible, not fatal.
  //
  // Before this, any signed-in account - the audit station's restricted
  // account included - could create, rewrite or delete any wipe record here,
  // and every other fix to the certificate was undone by that one route.
  private async screen(
    entry: CrudEntry,
    user: RequestUser,
  ): Promise<{ entry: CrudEntry; skip?: undefined } | { entry?: undefined; skip: string }> {
    const { table, op } = entry;

    // 1. The trail is append-only. The web app only ever INSERTs audits and
    //    history (checked: audit-form.tsx, scan/page.tsx), so a PATCH, a DELETE,
    //    or a PUT that would overwrite an existing row is tampering or a bug -
    //    either way it must not rewrite what a certificate reads. A PUT for a
    //    row that already landed is also exactly what a retried upload looks
    //    like, and skipping it is the correct idempotent answer.
    if (table === 'asset_audits' || table === 'asset_history') {
      if (op !== 'PUT') return { skip: `${table} is append-only; ${op} refused` };
      const repo: Repository<any> = table === 'asset_audits' ? this.audits : this.history;
      const existing = await repo.findOne({ where: { id: entry.id }, select: { id: true } });
      if (existing) return { skip: `${table} is append-only; ${entry.id} already exists` };
    }

    // 2. Recording an audit needs the grant the online route has always required.
    if (table === 'asset_audits' && !(await holds(this.permissions, user.userId, AUDIT_PERMISSIONS))) {
      return { skip: 'recording an audit needs Perform Goods In Audit or Perform Amazon Audit' };
    }

    // 3. So does deleting a device.
    if (table === 'assets' && op === 'DELETE' && !(await holds(this.permissions, user.userId, ['delete_asset']))) {
      return { skip: 'deleting a device needs Delete Asset' };
    }

    if (op === 'DELETE') return { entry };

    // 4. Keep only the columns this table allows (SYNC_WRITABLE above), and on
    //    an EXISTING device only the non-identity ones. A PUT aimed at a device
    //    that already exists is an overwrite, so it is held to the same rule.
    let allowed = SYNC_WRITABLE[table];
    if (table === 'assets') {
      const exists =
        op === 'PATCH' ||
        !!(await this.assets.findOne({ where: { id: entry.id }, select: { id: true } }));
      if (exists) allowed = new Set([...allowed].filter((k) => !ASSET_IDENTITY.has(k)));
    }
    const data: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(entry.data ?? {})) {
      if (allowed.has(k)) data[k] = v;
      else dropped.push(k);
    }
    if (dropped.length) {
      this.logger.warn(
        `sync: dropped ${dropped.join(', ')} from ${op} ${table}/${entry.id} by user ${user.userId}`,
      );
    }
    if ('created_at' in data && !acceptableCreatedAt(data.created_at)) delete data.created_at;
    // The author is whoever is signed in - applyOne sets audited_by_id; history
    // gets its user here. No client of ours sends either.
    if (table === 'asset_history') data.user_id = user.userId;

    // 5. A hand-typed claim that data was erased. Allowed with its own grant,
    //    and labelled 'manual' so the certificate says so. Without the grant the
    //    CLAIM is dropped, not the record: the audit's grade and notes still
    //    land, the device keeps the status it had, and the note says why. Both
    //    fields carry the claim - the wipe record and the device's status - so
    //    both are checked, or it simply moves to whichever was not.
    const claimsWiped =
      (table === 'asset_audits' && data.data_wipe_status === 'wiped') ||
      ((table === 'asset_audits' || table === 'assets') && data.audit_status === 'data_wiped');
    if (claimsWiped && !(await mayRecordManualWipe(this.permissions, user.userId))) {
      if (data.data_wipe_status === 'wiped') delete data.data_wipe_status;
      if (data.audit_status === 'data_wiped') delete data.audit_status;
      if (table === 'asset_audits') {
        const why = '[Wipe not recorded: this account cannot mark a drive as wiped by hand.]';
        // typeof, not String(): a crafted object here must not throw and
        // wedge the queue.
        data.notes = typeof data.notes === 'string' && data.notes ? `${data.notes} ${why}` : why;
      }
      this.logger.warn(`sync: dropped a hand-typed wipe claim on ${table}/${entry.id} from user ${user.userId}`);
    }
    if (table === 'asset_audits' && data.data_wipe_status) data.wipe_source = 'manual';

    // A PATCH with nothing left to set - its only field was a dropped claim or
    // a dropped column - would make TypeORM throw, and wedge the queue.
    // e.g. the audit form's "UPDATE assets SET audit_status = 'data_wiped'".
    if (op === 'PATCH' && Object.keys(data).length === 0) {
      return { skip: 'nothing left to apply after screening' };
    }

    return { entry: { ...entry, data } };
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
  private async applyAuditSideEffects(entry: CrudEntry, userId: string, m?: EntityManager): Promise<void> {
    // Inside the caller's transaction when one is given, so these commit or
    // roll back with the audit row itself.
    const assets = m ? m.getRepository(Asset) : this.assets;
    const history = m ? m.getRepository(AssetHistory) : this.history;
    const data = entry.data ?? {};
    const assetId = data.asset_id as string | undefined;
    if (!assetId) return;

    const patch: Record<string, unknown> = {};
    if (data.cosmetic_grade) patch.conditionGrade = data.cosmetic_grade;
    if (data.audit_status) patch.auditStatus = data.audit_status;
    if (Object.keys(patch).length > 0) {
      await assets.update({ id: assetId }, patch);
    }

    await history.save(
      history.create({
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
