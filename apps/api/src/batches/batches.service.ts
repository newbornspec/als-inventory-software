import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { Batch, BatchStatus } from './batch.entity';
import { Lot } from './lot.entity';
import { ExpectedLineItem } from './expected-line-item.entity';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { Asset, AssetStockStatus } from '../assets/asset.entity';
import { sanitizeUser, type SafeUser } from '../users/sanitize-user';
import { ActivityService } from '../activity/activity.service';
import { assertOwnsBatch, accessibleBatchWhere, type RequestUser } from '../common/ownership';
import { cleanCpuModel, screenSizeFor, standardiseRamGb } from '../common/spec-normalise';
import { UserRole } from '../users/user.entity';

export interface BatchWithCount extends Omit<Batch, 'receivedBy' | 'owner' | 'createdBy'> {
  receivedBy: SafeUser | null;
  owner: SafeUser | null;
  createdBy: SafeUser | null;
  actualUnitCount: number;
  // Sold-inclusive. actualUnitCount deliberately omits sold devices, so only this
  // one is safe to show before a destructive action.
  totalUnitCount: number;
  // Real row counts for the two other things a batch delete destroys. Needed so a
  // delete confirmation can never claim a lot is empty while it still holds a
  // supplier manifest or planned sub-lots.
  subLotCount: number;
  expectedLineCount: number;
  // Live per-lot roll-ups so the Lots view can show operational progress
  // (audit/grading throughput) without loading every asset.
  readyForSale: number;
  scrap: number;
  quarantine: number;
  audited: number;
}

@Injectable()
export class BatchesService {
  constructor(
    @InjectRepository(Batch) private batches: Repository<Batch>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
    private activity: ActivityService,
  ) {}

  // `user` scopes the result to owned lots for managers; admins/technicians and
  // internal callers (no user) see all.
  async findAll(user?: RequestUser): Promise<BatchWithCount[]> {
    const batches = await this.batches.find({
      where: accessibleBatchWhere(user),
      relations: ['location', 'receivedBy', 'owner', 'createdBy'],
      order: { createdAt: 'DESC' },
    });
    return this.withCounts(batches);
  }

  async findOne(id: string, user?: RequestUser): Promise<BatchWithCount> {
    const batch = await this.batches.findOne({
      where: { id },
      relations: ['location', 'receivedBy', 'owner', 'createdBy'],
    });
    if (!batch) throw new NotFoundException(`Batch ${id} not found`);
    // 403 if a scoped manager opens a lot they don't own. No-op for internal
    // callers that pass no user (their own ownership guard comes with writes).
    assertOwnsBatch(batch.ownerId, user);
    return (await this.withCounts([batch]))[0];
  }

  // Formatted .xlsx report for one lot: company header, lot details + counts,
  // then the full list of devices scanned into it (with allocated cost).
  async generateReport(
    id: string,
    user?: RequestUser | null,
  ): Promise<{ buffer: Buffer; filename: string }> {
    // Scopes to owner for managers (403 if they don't own it) and identifies
    // who generated the export.
    const batch = await this.findOne(id, user ?? undefined);
    // Load hardwareProfile too (select:false by default) so the report can carry
    // the full spec of each audited device, not just its identifiers.
    const assets = await this.assets
      .createQueryBuilder('asset')
      .leftJoinAndSelect('asset.location', 'location')
      .leftJoinAndSelect('asset.lot', 'lot')
      .addSelect('asset.hardwareProfile')
      .where('asset.batchId = :id', { id })
      // Group each sub-lot's devices together (ungrouped sort last), then by tag.
      .orderBy('lot.lotNumber', 'ASC')
      .addOrderBy('asset.tag', 'ASC')
      .getMany();
    const evenSplit =
      batch.totalCost != null && assets.length > 0 ? batch.totalCost / assets.length : null;
    const missing =
      batch.expectedUnitCount != null
        ? Math.max(0, batch.expectedUnitCount - batch.actualUnitCount)
        : null;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ALS Trade Wholesales';
    const ws = wb.addWorksheet('Lot Report');
    const headers = [
      'Manufacturer',
      'Model',
      'Device type',
      'Serial number',
      'Service tag',
      'Tag',
      'Sub-lot',
      'Grade',
      'Audit status',
      'CPU',
      'RAM',
      'Storage',
      'Graphics',
      'Display',
      'Operating system',
      'Battery health',
      'Unit cost (£)',
    ];
    const widths = [16, 22, 12, 18, 14, 16, 14, 10, 16, 30, 20, 26, 22, 18, 18, 14, 13];
    ws.columns = widths.map((w) => ({ width: w }));
    const lastCol = ws.getColumn(headers.length).letter;

    const title = (row: number, text: string, size: number) => {
      ws.mergeCells(`A${row}:${lastCol}${row}`);
      const cell = ws.getCell(`A${row}`);
      cell.value = text;
      cell.font = { size, bold: true };
    };
    title(1, 'ALS Trade Wholesales', 16);
    title(2, 'Purchase Lot Report', 12);

    const meta: [string, string | number][] = [
      ['Lot number', batch.batchNumber],
      ['Owner', batch.owner?.name ?? '—'],
      ['Created by', batch.createdBy?.name ?? '—'],
      ['Created date', batch.createdAt ? new Date(batch.createdAt).toLocaleString('en-GB') : '—'],
      ['Supplier', batch.source ?? '—'],
      ['Purchase order', batch.purchaseOrder ?? '—'],
      ['Delivery note', batch.deliveryNote ?? '—'],
      ['Purchase date', batch.purchaseDate ?? '—'],
      ['Received date', batch.receivedDate ?? '—'],
      ['Location', batch.location?.name ?? '—'],
      ['Status', prettyLabel(batch.status)],
      ['Expected units', batch.expectedUnitCount ?? '—'],
      ['Scanned units', batch.actualUnitCount],
      ['Missing', missing ?? '—'],
      ['Ready for sale', batch.readyForSale],
      ['Scrap', batch.scrap],
      ['Quarantine', batch.quarantine],
      ['Total cost (£)', batch.totalCost ?? '—'],
      ['Generated by', user?.email ?? '—'],
      ['Date generated', new Date().toLocaleString('en-GB')],
    ];
    let r = 4;
    for (const [label, value] of meta) {
      ws.getCell(`A${r}`).value = label;
      ws.getCell(`A${r}`).font = { bold: true };
      ws.getCell(`B${r}`).value = value;
      r += 1;
    }

    const headerRowIndex = r + 1;
    const headerRow = ws.getRow(headerRowIndex);
    headerRow.values = headers;
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
      cell.border = { bottom: { style: 'thin' } };
    });

    let dataRow = headerRowIndex + 1;
    let costTotal = 0;
    for (const a of assets) {
      const cost = a.purchaseCost ?? evenSplit;
      if (cost != null) costTotal += cost;

      // Compose readable spec strings from the captured hardware profile; each
      // falls back to '' so a device with no profile just leaves cells blank.
      const hp = a.hardwareProfile;
      const ident = hp?.identification;
      const cpu = hp?.cpu;
      const mem = hp?.memory;
      // Model only — no "(4C/8T)". Core and thread counts are still captured and
      // stay in hardware_profile for diagnostics; they just read as noise to a
      // buyer on a resale spec sheet, same reasoning as dropping the RAM speed.
      // Then tidied: "Intel(R) Core(TM) i7-4770 CPU @ 3.40GHz" -> "Intel Core
      // i7-4770 3.40GHz". The maker is kept here (unlike the label, which drops it
      // for width) because a spreadsheet reader wants Intel vs AMD.
      const cpuStr = cleanCpuModel(cpu?.model);
      // Capacity only. The type and speed stay in hardware_profile for diagnostics,
      // but a resale spec sheet wants "16 GB", not "16 GB DDR4 3200 MT/s" — the
      // extra detail reads as noise to a buyer and made the column unusably wide.
      const ramGb = standardiseRamGb(mem?.totalGb);
      const ramStr = ramGb != null ? `${ramGb} GB` : '';
      const storageStr = hp?.storage?.length
        ? hp.storage
            .map((d) => [d.capacity, d.type].filter(Boolean).join(' '))
            .filter(Boolean)
            .join(', ')
        : '';
      const gfxStr = hp?.graphics?.length
        ? hp.graphics
            .map((g) => g.model)
            .filter(Boolean)
            .join(', ')
        : '';
      // Size only for devices with a built-in panel; a tower has no screen size,
      // so printing one there would be mis-detected or stale data. Resolution is
      // still shown for anything that reported it.
      const deviceType = a.deviceType ?? ident?.deviceType ?? a.category ?? null;
      const displayStr = hp?.display
        ? [screenSizeFor(deviceType, hp.display.size), hp.display.resolution]
            .filter(Boolean)
            .join(' ')
        : '';

      ws.getRow(dataRow).values = [
        ident?.manufacturer ?? a.name ?? '',
        ident?.model ?? '',
        a.deviceType ?? ident?.deviceType ?? a.category ?? '',
        a.serialNumber ?? ident?.serialNumber ?? '',
        ident?.serviceTag ?? '',
        a.tag,
        a.lot?.lotNumber ?? '',
        prettyLabel(a.conditionGrade),
        prettyLabel(a.auditStatus),
        cpuStr,
        ramStr,
        storageStr,
        gfxStr,
        displayStr,
        hp?.system?.os ?? '',
        hp?.battery?.health ?? '',
        cost != null ? cost : '',
      ];
      dataRow += 1;
    }

    const totalRow = ws.getRow(dataRow + 1);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(2).value = `${assets.length} devices`;
    totalRow.getCell(headers.length).value = costTotal > 0 ? costTotal : '';
    totalRow.font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, filename: `${batch.batchNumber}-report.xlsx` };
  }

  async create(dto: CreateBatchDto, user: RequestUser): Promise<Batch> {
    const batchNumber = await this.nextBatchNumber();
    // A technician's lot is UNOWNED (a shared "pool" lot every manager can see
    // and manage); admins/managers own what they create. createdBy/receivedBy
    // always record who actually made it (an admin can reassign the owner later).
    const ownerId = user.role === UserRole.TECHNICIAN ? null : user.userId;
    const batch = await this.batches.save(
      this.batches.create({
        ...dto,
        batchNumber,
        receivedById: user.userId,
        ownerId,
        createdById: user.userId,
      }),
    );
    await this.activity.record({
      userId: user.userId,
      action: 'batch.created',
      entityType: 'batch',
      entityId: batch.id,
      summary: `Created ${batch.batchNumber}`,
    });
    return batch;
  }

  async update(id: string, dto: UpdateBatchDto, user?: RequestUser): Promise<BatchWithCount> {
    const before = await this.findOne(id, user); // 404s if missing, 403 if not owner
    await this.batches.update(id, dto);
    await this.activity.record({
      userId: user?.userId,
      action: 'batch.updated',
      entityType: 'batch',
      entityId: id,
      summary: `Edited ${before.batchNumber}`,
    });
    return this.findOne(id, user);
  }

  // Sell the whole lot: every remaining (non-sold) device in it is marked Sold
  // — stamped with who/when, written to each asset's history, moved to the
  // Sold archive and locked — and the lot's status becomes 'sold'. Managers
  // can only sell lots they can access (findOne enforces that).
  async sellBatch(
    id: string,
    user: RequestUser,
    saleTotal?: number,
  ): Promise<{ soldCount: number }> {
    const before = await this.findOne(id, user); // 404s if missing, 403 if not owner

    const toSell = await this.assets
      .createQueryBuilder('asset')
      .select(['asset.id'])
      .where(`asset.batch_id = :id AND asset.stock_status != 'sold'`, { id })
      .getMany();
    const soldCount = toSell.length;

    if (soldCount > 0) {
      // Per-device history first (captures each unit's transition), then one
      // bulk update — set-based so a 200-unit lot doesn't need 400 round trips.
      await this.assets.query(
        `INSERT INTO "asset_history" ("asset_id", "event_type", "user_id", "notes")
         SELECT "id", 'status_changed', $2, "stock_status" || ' -> sold (lot sold)'
         FROM "assets" WHERE "batch_id" = $1 AND "stock_status" != 'sold'`,
        [id, user.userId],
      );
      await this.assets
        .createQueryBuilder()
        .update()
        .set({
          stockStatus: AssetStockStatus.SOLD,
          soldAt: () => 'now()',
          soldById: user.userId,
        })
        .where(`batch_id = :id AND stock_status != 'sold'`, { id })
        .execute();

      // Optional lot sale total, split evenly per device (rounding remainder
      // lands on one unit so the sum always equals what was entered).
      if (saleTotal != null && saleTotal >= 0) {
        const per = Math.floor((saleTotal / soldCount) * 100) / 100;
        const ids = toSell.map((a) => a.id);
        await this.assets.update({ id: In(ids) }, { salePrice: per });
        const remainder = Math.round((saleTotal - per * soldCount) * 100) / 100;
        if (remainder !== 0) {
          await this.assets.update(ids[0], {
            salePrice: Math.round((per + remainder) * 100) / 100,
          });
        }
      }
    }

    await this.batches.update(id, { status: BatchStatus.SOLD });
    await this.activity.record({
      userId: user.userId,
      action: 'batch.sold',
      entityType: 'batch',
      entityId: id,
      summary: `Sold ${before.batchNumber} (${soldCount} device${soldCount === 1 ? '' : 's'})`,
    });
    return { soldCount };
  }

  // Admin-only: hand a lot to a different owner. Not owner-guarded (admins are
  // never scoped); the controller restricts it to admins.
  async reassignOwner(id: string, ownerId: string, user?: RequestUser): Promise<BatchWithCount> {
    const before = await this.findOne(id);
    await this.batches.update(id, { ownerId });
    const after = await this.findOne(id);
    await this.activity.record({
      userId: user?.userId,
      action: 'batch.ownership_transferred',
      entityType: 'batch',
      entityId: id,
      summary: `Transferred ownership of ${before.batchNumber} to ${after.owner?.name ?? 'another user'}`,
    });
    return after;
  }

  // Deletes the lot AND everything in it. Note what the database does NOT do for
  // us: assets.batch_id and lots.batch_id are both ON DELETE SET NULL
  // (1752040000000-CreateBatchesAndLots.ts:50,57), so plainly deleting the batch
  // row would leave its devices and sub-lots alive but parentless — no supplier,
  // no cost basis, invisible to scoped managers, and purged from every offline
  // client with no bucket that can ever match batch_id IS NULL again. Orphaning is
  // strictly worse than either keeping or deleting, so we delete explicitly.
  async remove(id: string, userId?: string): Promise<void> {
    const before = await this.findOne(id);

    // Counted sold-inclusive on purpose. withCounts() excludes sold devices from
    // actualUnitCount, so reusing that number here would let a delete that
    // destroys a whole consignment's sale history look like it cleared an
    // empty lot.
    const totals = await this.assets
      .createQueryBuilder('asset')
      .select('COUNT(*)', 'total')
      .addSelect(`COUNT(*) FILTER (WHERE asset.stock_status = 'sold')`, 'sold')
      .where('asset.batchId = :id', { id })
      .getRawOne<{ total: string; sold: string }>();
    const assetCount = parseInt(totals?.total ?? '0', 10);
    const soldCount = parseInt(totals?.sold ?? '0', 10);

    // One transaction — a half-deleted lot is the orphan case above, arrived at by
    // accident. Order is deliberate:
    //   assets first  — asset_audits, asset_history, asset_photos and repair_logs
    //                   are ON DELETE CASCADE off assets, so this is the step that
    //                   removes each device's audit trail and wipe evidence
    //   sub-lots next  — SET NULL would strand them, so remove them here
    //   the batch last — cascades expected_line_items, the supplier manifest
    await this.batches.manager.transaction(async (tx) => {
      await tx.delete(Asset, { batchId: id });
      await tx.delete(Lot, { batchId: id });
      await tx.delete(Batch, { id });
    });

    // Snapshot the lot's identity into the log line. The row is gone, and its
    // supplier, cost and received date exist nowhere else afterwards — same
    // reasoning as pallet_sold_lines snapshotting pallet_number so profit stays
    // computable once the source row has been removed.
    const detail = [
      before.source ? `supplier ${before.source}` : null,
      before.totalCost != null ? `cost £${before.totalCost}` : null,
      before.receivedDate ? `received ${before.receivedDate}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    await this.activity.record({
      userId,
      action: 'batch.deleted',
      entityType: 'batch',
      entityId: id,
      summary:
        `Deleted ${before.batchNumber} and its ${assetCount} device${assetCount === 1 ? '' : 's'}` +
        (soldCount > 0 ? ` (${soldCount} sold)` : '') +
        (detail ? ` · ${detail}` : ''),
    });
  }

  // Never stored — always a live count of assets pointing at this batch, so
  // it's impossible for it to drift from what's actually been scanned in.
  private async withCounts(batches: Batch[]): Promise<BatchWithCount[]> {
    if (batches.length === 0) return [];
    // Sold assets keep their batch link for provenance but are out of active
    // inventory, so they must not count toward any lot's LIVE totals. That
    // exclusion used to be a WHERE on the whole query; it is now per-aggregate so
    // the same pass can also return `everything` — the sold-INCLUSIVE count.
    // Destructive actions must be measured against that one: a fully-sold lot has
    // an actualUnitCount of 0 while still holding an entire consignment.
    const LIVE = `asset.stock_status != 'sold'`;
    const rows = await this.assets
      .createQueryBuilder('asset')
      .select('asset.batchId', 'batchId')
      .addSelect(`COUNT(*) FILTER (WHERE ${LIVE})`, 'total')
      .addSelect('COUNT(*)', 'everything')
      .addSelect(
        `COUNT(*) FILTER (WHERE asset.audit_status = 'ready_for_sale' AND ${LIVE})`,
        'readyForSale',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE (asset.condition_grade = 'scrap' OR asset.audit_status = 'ber') AND ${LIVE})`,
        'scrap',
      )
      // No LIVE clause needed — 'quarantined' and 'sold' are the same column, so
      // a quarantined row cannot also be sold.
      .addSelect(`COUNT(*) FILTER (WHERE asset.stock_status = 'quarantined')`, 'quarantine')
      .addSelect(`COUNT(*) FILTER (WHERE asset.audit_status IS NOT NULL AND ${LIVE})`, 'audited')
      .where('asset.batchId IN (:...ids)', { ids: batches.map((b) => b.id) })
      .groupBy('asset.batchId')
      .getRawMany<{
        batchId: string;
        total: string;
        everything: string;
        readyForSale: string;
        scrap: string;
        quarantine: string;
        audited: string;
      }>();
    // Sub-lots and imported manifest lines are user-authored data that a batch
    // delete cascades away, so their REAL counts have to travel with the batch —
    // expectedUnitCount is a hand-typed declared figure (batch.entity.ts:83) and
    // says nothing about how many manifest rows exist. Queried through the shared
    // manager so this needs no extra repositories in the module.
    const ids = batches.map((b) => b.id);
    const [subLotRows, expectedRows] = await Promise.all([
      this.batches.manager
        .createQueryBuilder(Lot, 'lot')
        .select('lot.batchId', 'batchId')
        .addSelect('COUNT(*)', 'total')
        .where('lot.batchId IN (:...ids)', { ids })
        .groupBy('lot.batchId')
        .getRawMany<{ batchId: string; total: string }>(),
      this.batches.manager
        .createQueryBuilder(ExpectedLineItem, 'eli')
        .select('eli.batchId', 'batchId')
        .addSelect('COUNT(*)', 'total')
        .where('eli.batchId IN (:...ids)', { ids })
        .groupBy('eli.batchId')
        .getRawMany<{ batchId: string; total: string }>(),
    ]);
    const subLots = new Map(subLotRows.map((r) => [r.batchId, parseInt(r.total, 10)]));
    const expected = new Map(expectedRows.map((r) => [r.batchId, parseInt(r.total, 10)]));

    const map = new Map(rows.map((r) => [r.batchId, r]));
    return batches.map((b) => {
      const r = map.get(b.id);
      return {
        ...b,
        receivedBy: b.receivedBy ? sanitizeUser(b.receivedBy) : null,
        owner: b.owner ? sanitizeUser(b.owner) : null,
        createdBy: b.createdBy ? sanitizeUser(b.createdBy) : null,
        actualUnitCount: r ? parseInt(r.total, 10) : 0,
        totalUnitCount: r ? parseInt(r.everything, 10) : 0,
        subLotCount: subLots.get(b.id) ?? 0,
        expectedLineCount: expected.get(b.id) ?? 0,
        readyForSale: r ? parseInt(r.readyForSale, 10) : 0,
        scrap: r ? parseInt(r.scrap, 10) : 0,
        quarantine: r ? parseInt(r.quarantine, 10) : 0,
        audited: r ? parseInt(r.audited, 10) : 0,
      };
    });
  }

  private async nextBatchNumber(): Promise<string> {
    const result = await this.batches.query(`SELECT nextval('batch_number_seq') AS n`);
    const n = String(result[0].n).padStart(6, '0');
    return `BATCH-${n}`;
  }
}

// e.g. "grade_a" -> "Grade A", "in_stock" -> "In Stock", null -> "".
function prettyLabel(value: string | null): string {
  if (!value) return '';
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
