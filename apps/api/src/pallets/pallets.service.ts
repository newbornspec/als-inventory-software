import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { Pallet, PalletStatus } from './pallet.entity';
import { PalletLine } from './pallet-line.entity';
import { Product, ProductTrackingType } from '../products/product.entity';
import { CreatePalletDto } from './dto/create-pallet.dto';
import { UpdatePalletDto } from './dto/update-pallet.dto';
import { CreatePalletLineDto } from './dto/create-pallet-line.dto';
import { UpdatePalletLineDto } from './dto/update-pallet-line.dto';
import { CreatePalletSpecDto, SpecRowDto } from './dto/create-pallet-spec.dto';
import { LookupsService } from '../lookups/lookups.service';

export interface PalletWithTotals extends Pallet {
  totalQuantity: number;
  lineCount: number;
}

@Injectable()
export class PalletsService {
  constructor(
    @InjectRepository(Pallet) private pallets: Repository<Pallet>,
    @InjectRepository(PalletLine) private lines: Repository<PalletLine>,
    @InjectRepository(Product) private products: Repository<Product>,
    private lookupsService: LookupsService,
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

  // Layout 2 create: one pallet + a line per spec row. Each row find-or-creates
  // a catalogue Product (so specs are reusable and searchable), and the line
  // carries a composed "variant" label so it displays/reports like any other.
  async createFromSpec(dto: CreatePalletSpecDto): Promise<Pallet> {
    const { rows, ...meta } = dto;
    const palletNumber = await this.nextPalletNumber();
    const pallet = await this.pallets.save(this.pallets.create({ ...meta, palletNumber }));

    for (const row of rows) {
      await this.persistLookups(row);
      const product = await this.findOrCreateProduct(row);
      await this.lines.save(
        this.lines.create({
          palletId: pallet.id,
          productId: product.id,
          variant: composeVariant(row) || 'Unspecified',
          quantity: Math.max(0, Math.trunc(row.quantity) || 0),
        }),
      );
    }
    return pallet;
  }

  // Save any new dropdown values a user typed so they appear next time. Model is
  // scoped to its manufacturer (find-or-created first to get its id).
  private async persistLookups(row: SpecRowDto): Promise<void> {
    const manufacturer = nz(row.manufacturer);
    const manLookup = manufacturer
      ? await this.lookupsService.findOrCreate('manufacturer', manufacturer)
      : null;
    if (nz(row.model)) {
      await this.lookupsService.findOrCreate('model', row.model!, manLookup?.id ?? null);
    }
    for (const [category, value] of [
      ['chassis', row.chassis],
      ['cpu', row.cpu],
      ['ram', row.ram],
      ['storage', row.storage],
    ] as const) {
      if (nz(value)) await this.lookupsService.findOrCreate(category, value!);
    }
  }

  // Reuse an existing PALLET-tier catalogue entry with the same spec, else make
  // one — this is what turns a typed spec into reusable, searchable data.
  private async findOrCreateProduct(row: SpecRowDto): Promise<Product> {
    const spec = {
      manufacturer: nz(row.manufacturer),
      model: nz(row.model),
      chassis: nz(row.chassis),
      cpu: nz(row.cpu),
      ramGb: parseRamGb(row.ram),
      storage: nz(row.storage),
    };
    // NULL columns must be matched with IsNull(), not raw null.
    const where: FindOptionsWhere<Product> = {
      trackingType: ProductTrackingType.PALLET,
      manufacturer: spec.manufacturer ?? IsNull(),
      model: spec.model ?? IsNull(),
      chassis: spec.chassis ?? IsNull(),
      cpu: spec.cpu ?? IsNull(),
      ramGb: spec.ramGb ?? IsNull(),
      storage: spec.storage ?? IsNull(),
    };
    const existing = await this.products.findOne({ where });
    if (existing) return existing;
    return this.products.save(
      this.products.create({
        ...spec,
        name: composeVariant(row) || 'Unspecified',
        trackingType: ProductTrackingType.PALLET,
      }),
    );
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
    ws.columns = [
      { width: 40 }, // Variant / size (wider so long names fit)
      { width: 10 }, // Tier
      { width: 12 }, // Quantity
      { width: 14 }, // Grade
      { width: 14 }, // Unit cost
      { width: 16 }, // Line total
    ];

    const title = (row: number, text: string, size: number) => {
      ws.mergeCells(`A${row}:F${row}`);
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
      ['Buyer', pallet.buyer ?? '—'],
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
    headerRow.values = [
      'Variant / size',
      'Tier',
      'Quantity',
      'Grade',
      'Unit cost (£)',
      'Line total (£)',
    ];
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
        slugLabel(line.tier),
        line.quantity,
        gradeLabel(line.grade),
        cost != null ? cost : '',
        lineTotal != null ? lineTotal : '',
      ];
      dataRow += 1;
    }

    const totalRow = ws.getRow(dataRow + 1);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(3).value = pallet.totalQuantity;
    totalRow.getCell(6).value = costTotal > 0 ? costTotal : '';
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

// Empty/whitespace -> null, so blank spec cells are stored (and matched) as NULL.
function nz(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

// "8 GB" / "16GB" -> 8 / 16; null when there's no number.
function parseRamGb(ram: string | null | undefined): number | null {
  const m = (ram ?? '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// A readable one-line label for a spec row, used as the pallet line's variant
// and the product name.
function composeVariant(row: {
  manufacturer?: string | null;
  model?: string | null;
  chassis?: string | null;
  cpu?: string | null;
  ram?: string | null;
  storage?: string | null;
}): string {
  return [row.manufacturer, row.model, row.chassis, row.cpu, row.ram, row.storage]
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join(' · ');
}

// e.g. "grade_a" -> "Grade A", "for_parts" -> "For Parts".
function gradeLabel(grade: string | null): string {
  return slugLabel(grade);
}

// e.g. "tier_1" -> "Tier 1"; empty for null.
function slugLabel(value: string | null): string {
  if (!value) return '';
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
