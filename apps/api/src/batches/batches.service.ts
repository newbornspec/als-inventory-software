import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { Batch } from './batch.entity';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { Asset } from '../assets/asset.entity';
import { sanitizeUser, type SafeUser } from '../users/sanitize-user';

export interface BatchWithCount extends Omit<Batch, 'receivedBy'> {
  receivedBy: SafeUser | null;
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
  ) {}

  async findAll(): Promise<BatchWithCount[]> {
    const batches = await this.batches.find({
      relations: ['location', 'receivedBy'],
      order: { createdAt: 'DESC' },
    });
    return this.withCounts(batches);
  }

  async findOne(id: string): Promise<BatchWithCount> {
    const batch = await this.batches.findOne({
      where: { id },
      relations: ['location', 'receivedBy'],
    });
    if (!batch) throw new NotFoundException(`Batch ${id} not found`);
    return (await this.withCounts([batch]))[0];
  }

  // Formatted .xlsx report for one lot: company header, lot details + counts,
  // then the full list of devices scanned into it (with allocated cost).
  async generateReport(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const batch = await this.findOne(id);
    const assets = await this.assets.find({
      where: { batchId: id },
      relations: ['location'],
      order: { tag: 'ASC' },
    });
    const evenSplit =
      batch.totalCost != null && assets.length > 0 ? batch.totalCost / assets.length : null;
    const missing =
      batch.expectedUnitCount != null
        ? Math.max(0, batch.expectedUnitCount - batch.actualUnitCount)
        : null;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ALS Trade Wholesales';
    const ws = wb.addWorksheet('Lot Report');
    ws.columns = [
      { width: 22 },
      { width: 30 },
      { width: 16 },
      { width: 16 },
      { width: 12 },
      { width: 18 },
      { width: 14 },
    ];

    const title = (row: number, text: string, size: number) => {
      ws.mergeCells(`A${row}:G${row}`);
      const cell = ws.getCell(`A${row}`);
      cell.value = text;
      cell.font = { size, bold: true };
    };
    title(1, 'ALS Trade Wholesales', 16);
    title(2, 'Purchase Lot Report', 12);

    const meta: [string, string | number][] = [
      ['Date generated', new Date().toLocaleString('en-GB')],
      ['Lot number', batch.batchNumber],
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
    headerRow.values = ['Tag', 'Name', 'Category', 'Stock status', 'Grade', 'Audit status', 'Unit cost (£)'];
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
      ws.getRow(dataRow).values = [
        a.tag,
        a.name,
        a.category,
        prettyLabel(a.stockStatus),
        prettyLabel(a.conditionGrade),
        prettyLabel(a.auditStatus),
        cost != null ? cost : '',
      ];
      dataRow += 1;
    }

    const totalRow = ws.getRow(dataRow + 1);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(2).value = `${assets.length} devices`;
    totalRow.getCell(7).value = costTotal > 0 ? costTotal : '';
    totalRow.font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, filename: `${batch.batchNumber}-report.xlsx` };
  }

  async create(dto: CreateBatchDto, userId: string): Promise<Batch> {
    const batchNumber = await this.nextBatchNumber();
    return this.batches.save(
      this.batches.create({ ...dto, batchNumber, receivedById: userId }),
    );
  }

  async update(id: string, dto: UpdateBatchDto): Promise<BatchWithCount> {
    await this.findOne(id); // 404s if missing
    await this.batches.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.batches.delete(id);
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
