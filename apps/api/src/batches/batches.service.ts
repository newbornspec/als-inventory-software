import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { Batch } from './batch.entity';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { Asset } from '../assets/asset.entity';
import { sanitizeUser, type SafeUser } from '../users/sanitize-user';
import { ActivityService } from '../activity/activity.service';
import { assertOwnsBatch, ownerWhere, type RequestUser } from '../common/ownership';

export interface BatchWithCount extends Omit<Batch, 'receivedBy' | 'owner' | 'createdBy'> {
  receivedBy: SafeUser | null;
  owner: SafeUser | null;
  createdBy: SafeUser | null;
  actualUnitCount: number;
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
      where: ownerWhere(user),
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
      const cpuStr = cpu
        ? [
            cpu.model,
            cpu.cores || cpu.threads ? `(${cpu.cores ?? '?'}C/${cpu.threads ?? '?'}T)` : '',
          ]
            .filter(Boolean)
            .join(' ')
        : '';
      const ramStr = mem
        ? [mem.totalGb ? `${mem.totalGb} GB` : '', mem.type, mem.speed].filter(Boolean).join(' ')
        : '';
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
      const displayStr = hp?.display
        ? [hp.display.size, hp.display.resolution].filter(Boolean).join(' ')
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

  async create(dto: CreateBatchDto, userId: string): Promise<Batch> {
    const batchNumber = await this.nextBatchNumber();
    // Owner + author + receiver all default to the creator; an admin can
    // reassign ownership later. receivedById kept for backward compatibility.
    const batch = await this.batches.save(
      this.batches.create({
        ...dto,
        batchNumber,
        receivedById: userId,
        ownerId: userId,
        createdById: userId,
      }),
    );
    await this.activity.record({
      userId,
      action: 'batch.created',
      entityType: 'batch',
      entityId: batch.id,
      summary: `Created ${batch.batchNumber}`,
    });
    return batch;
  }

  async update(id: string, dto: UpdateBatchDto, userId?: string): Promise<BatchWithCount> {
    const before = await this.findOne(id); // 404s if missing
    await this.batches.update(id, dto);
    await this.activity.record({
      userId,
      action: 'batch.updated',
      entityType: 'batch',
      entityId: id,
      summary: `Edited ${before.batchNumber}`,
    });
    return this.findOne(id);
  }

  async remove(id: string, userId?: string): Promise<void> {
    const before = await this.findOne(id);
    await this.batches.delete(id);
    await this.activity.record({
      userId,
      action: 'batch.deleted',
      entityType: 'batch',
      entityId: id,
      summary: `Deleted ${before.batchNumber}`,
    });
  }

  // Never stored — always a live count of assets pointing at this batch, so
  // it's impossible for it to drift from what's actually been scanned in.
  private async withCounts(batches: Batch[]): Promise<BatchWithCount[]> {
    if (batches.length === 0) return [];
    const rows = await this.assets
      .createQueryBuilder('asset')
      .select('asset.batchId', 'batchId')
      .addSelect('COUNT(*)', 'total')
      .addSelect(`COUNT(*) FILTER (WHERE asset.audit_status = 'ready_for_sale')`, 'readyForSale')
      .addSelect(
        `COUNT(*) FILTER (WHERE asset.condition_grade = 'scrap' OR asset.audit_status = 'ber')`,
        'scrap',
      )
      .addSelect(`COUNT(*) FILTER (WHERE asset.stock_status = 'quarantined')`, 'quarantine')
      .addSelect(`COUNT(*) FILTER (WHERE asset.audit_status IS NOT NULL)`, 'audited')
      .where('asset.batchId IN (:...ids)', { ids: batches.map((b) => b.id) })
      .groupBy('asset.batchId')
      .getRawMany<{
        batchId: string;
        total: string;
        readyForSale: string;
        scrap: string;
        quarantine: string;
        audited: string;
      }>();
    const map = new Map(rows.map((r) => [r.batchId, r]));
    return batches.map((b) => {
      const r = map.get(b.id);
      return {
        ...b,
        receivedBy: b.receivedBy ? sanitizeUser(b.receivedBy) : null,
        owner: b.owner ? sanitizeUser(b.owner) : null,
        createdBy: b.createdBy ? sanitizeUser(b.createdBy) : null,
        actualUnitCount: r ? parseInt(r.total, 10) : 0,
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
