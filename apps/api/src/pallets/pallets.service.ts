import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { Pallet, PalletStatus } from './pallet.entity';
import { PalletLine } from './pallet-line.entity';
import { CreatePalletDto } from './dto/create-pallet.dto';
import { UpdatePalletDto } from './dto/update-pallet.dto';
import { CreatePalletLineDto } from './dto/create-pallet-line.dto';
import { UpdatePalletLineDto } from './dto/update-pallet-line.dto';

export interface PalletWithTotals extends Pallet {
  totalQuantity: number;
  lineCount: number;
}

@Injectable()
export class PalletsService {
  constructor(
    @InjectRepository(Pallet) private pallets: Repository<Pallet>,
    @InjectRepository(PalletLine) private lines: Repository<PalletLine>,
  ) {}

  async findAll(): Promise<PalletWithTotals[]> {
    const pallets = await this.pallets.find({
      relations: ['location'],
      order: { createdAt: 'DESC' },
    });
    return this.withTotals(pallets);
  }

  async findOne(id: string): Promise<PalletWithTotals & { lines: PalletLine[] }> {
    const pallet = await this.pallets.findOne({ where: { id }, relations: ['location'] });
    if (!pallet) throw new NotFoundException(`Pallet ${id} not found`);
    const [withTotals] = await this.withTotals([pallet]);
    const lines = await this.lines.find({
      where: { palletId: id },
      order: { createdAt: 'ASC' },
    });
    return { ...withTotals, lines };
  }

  async create(dto: CreatePalletDto): Promise<Pallet> {
    const palletNumber = await this.nextPalletNumber();
    return this.pallets.save(this.pallets.create({ ...dto, palletNumber }));
  }

  async update(id: string, dto: UpdatePalletDto): Promise<PalletWithTotals> {
    const before = await this.pallets.findOne({ where: { id } });
    if (!before) throw new NotFoundException(`Pallet ${id} not found`);

    // Stamp the ship time on the transition into 'shipped'; clear it if the
    // pallet is brought back to open/ready.
    const patch: Partial<Pallet> = { ...dto };
    if (dto.status === PalletStatus.SHIPPED && before.status !== PalletStatus.SHIPPED) {
      patch.shippedAt = new Date();
    } else if (dto.status && dto.status !== PalletStatus.SHIPPED) {
      patch.shippedAt = null;
    }

    await this.pallets.update(id, patch);
    return (
      await this.withTotals([
        await this.pallets.findOneOrFail({ where: { id }, relations: ['location'] }),
      ])
    )[0];
  }

  // Build a formatted .xlsx pallet report with a company header block and the
  // full variant list (with costs). Returned as a buffer for the controller to
  // stream as a download.
  async generateReport(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const pallet = await this.findOne(id);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ALS Trade Wholesales';
    const ws = wb.addWorksheet('Pallet Report');
    ws.columns = [{ width: 36 }, { width: 22 }, { width: 12 }, { width: 14 }, { width: 16 }];

    const title = (row: number, text: string, size: number) => {
      ws.mergeCells(`A${row}:E${row}`);
      const cell = ws.getCell(`A${row}`);
      cell.value = text;
      cell.font = { size, bold: true };
    };
    title(1, 'ALS Trade Wholesales', 16);
    title(2, 'Pallet Report', 12);

    const meta: [string, string | number][] = [
      ['Date generated', new Date().toLocaleString('en-GB')],
      ['Pallet number', pallet.palletNumber],
      ['Supplier', pallet.supplier ?? '—'],
      ['Description', pallet.description ?? '—'],
      ['Location', pallet.location?.name ?? '—'],
      ['Status', pallet.status],
      ['Total items', pallet.totalQuantity],
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
    headerRow.values = ['Variant / size', 'Supplier', 'Quantity', 'Unit cost (£)', 'Line total (£)'];
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
      cell.border = { bottom: { style: 'thin' } };
    });

    let costTotal = 0;
    let dataRow = headerRowIndex + 1;
    for (const line of pallet.lines) {
      const cost = line.unitCost;
      const lineTotal = cost != null ? cost * line.quantity : null;
      if (lineTotal != null) costTotal += lineTotal;
      const row = ws.getRow(dataRow);
      row.values = [
        line.variant,
        line.supplier || pallet.supplier || '',
        line.quantity,
        cost != null ? cost : '',
        lineTotal != null ? lineTotal : '',
      ];
      dataRow += 1;
    }

    const totalRow = ws.getRow(dataRow + 1);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(3).value = pallet.totalQuantity;
    totalRow.getCell(5).value = costTotal > 0 ? costTotal : '';
    totalRow.font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, filename: `${pallet.palletNumber}-report.xlsx` };
  }

  async remove(id: string): Promise<void> {
    await this.assertPallet(id);
    await this.pallets.delete(id); // cascades pallet_lines
  }

  // --- lines ---

  async addLine(palletId: string, dto: CreatePalletLineDto): Promise<PalletLine> {
    await this.assertPallet(palletId);
    return this.lines.save(this.lines.create({ ...dto, palletId }));
  }

  async updateLine(palletId: string, lineId: string, dto: UpdatePalletLineDto): Promise<PalletLine> {
    const line = await this.lines.findOne({ where: { id: lineId, palletId } });
    if (!line) throw new NotFoundException(`Line ${lineId} not found on pallet ${palletId}`);
    await this.lines.update(lineId, dto);
    return this.lines.findOneOrFail({ where: { id: lineId } });
  }

  async removeLine(palletId: string, lineId: string): Promise<void> {
    const line = await this.lines.findOne({ where: { id: lineId, palletId } });
    if (!line) throw new NotFoundException(`Line ${lineId} not found on pallet ${palletId}`);
    await this.lines.delete(lineId);
  }

  // Totals are always summed live from the lines, never stored, so they can't
  // drift from the counts.
  private async withTotals(pallets: Pallet[]): Promise<PalletWithTotals[]> {
    if (pallets.length === 0) return [];
    const rows = await this.lines
      .createQueryBuilder('line')
      .select('line.palletId', 'palletId')
      .addSelect('COALESCE(SUM(line.quantity), 0)', 'total')
      .addSelect('COUNT(*)', 'lines')
      .where('line.palletId IN (:...ids)', { ids: pallets.map((p) => p.id) })
      .groupBy('line.palletId')
      .getRawMany<{ palletId: string; total: string; lines: string }>();
    const map = new Map(rows.map((r) => [r.palletId, r]));
    return pallets.map((p) => ({
      ...p,
      totalQuantity: parseInt(map.get(p.id)?.total ?? '0', 10),
      lineCount: parseInt(map.get(p.id)?.lines ?? '0', 10),
    }));
  }

  private async nextPalletNumber(): Promise<string> {
    const result = await this.pallets.query(`SELECT nextval('pallet_number_seq') AS n`);
    const n = String(result[0].n).padStart(6, '0');
    return `PALLET-${n}`;
  }

  private async assertPallet(id: string): Promise<void> {
    const count = await this.pallets.countBy({ id });
    if (count === 0) throw new NotFoundException(`Pallet ${id} not found`);
  }
}
