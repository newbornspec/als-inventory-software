import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { Pallet, PalletStatus, PalletEntryLayout } from './pallet.entity';
import { PalletLine } from './pallet-line.entity';
import { PalletSoldLine } from './pallet-sold-line.entity';
import { Product, ProductTrackingType } from '../products/product.entity';
import { CreatePalletDto } from './dto/create-pallet.dto';
import { UpdatePalletDto } from './dto/update-pallet.dto';
import { CreatePalletLineDto } from './dto/create-pallet-line.dto';
import { UpdatePalletLineDto } from './dto/update-pallet-line.dto';
import { CreatePalletSpecDto, SpecRowDto } from './dto/create-pallet-spec.dto';
import { LookupsService } from '../lookups/lookups.service';
import { sanitizeUser } from '../users/sanitize-user';

export interface PalletWithTotals extends Pallet {
  totalQuantity: number;
  lineCount: number;
}

@Injectable()
export class PalletsService {
  constructor(
    @InjectRepository(Pallet) private pallets: Repository<Pallet>,
    @InjectRepository(PalletLine) private lines: Repository<PalletLine>,
    @InjectRepository(PalletSoldLine) private soldLines: Repository<PalletSoldLine>,
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
    // product is included so the Layout 2 grid editor can rebuild its rows
    // (manufacturer/model/…/gen) from the linked catalogue entries.
    const lines = await this.lines.find({
      where: { palletId: id },
      relations: { product: true },
      order: { createdAt: 'ASC' },
    });
    return { ...withTotals, lines };
  }

  async create(dto: CreatePalletDto): Promise<Pallet> {
    // Destructure the typed number OUT of the dto before spreading. Spreading
    // the dto and then overriding palletNumber (as this did) silently discards
    // whatever the operator typed — the whole feature looks wired up and every
    // pallet still comes out PALLET-000xxx.
    const { palletNumber: typed, ...rest } = dto;
    const palletNumber = (typed ?? '').trim() || (await this.nextPalletNumber());
    return this.saveUnique(() => this.pallets.save(this.pallets.create({ ...rest, palletNumber })),
                           palletNumber);
  }

  // Layout 2 create: one pallet + a line per spec row. Each row find-or-creates
  // a catalogue Product (so specs are reusable and searchable), and the line
  // carries a composed "variant" label so it displays/reports like any other.
  async createFromSpec(dto: CreatePalletSpecDto): Promise<Pallet> {
    const { rows, palletNumber: typed, ...meta } = dto;
    const palletNumber = (typed ?? '').trim() || (await this.nextPalletNumber());
    const pallet = await this.saveUnique(
      () =>
        this.pallets.save(
          this.pallets.create({ ...meta, palletNumber, entryLayout: PalletEntryLayout.SPEC }),
        ),
      palletNumber,
    );
    await this.createLinesFromSpec(pallet.id, rows ?? []);
    return pallet;
  }

  // Layout 2 editor save: update the pallet's metadata and replace ALL its
  // lines with the current grid rows — the grid is the source of truth, so a
  // full replace keeps save semantics simple (edits, deletes and reorders all
  // fall out of it).
  async replaceSpec(
    id: string,
    dto: CreatePalletSpecDto,
  ): Promise<PalletWithTotals & { lines: PalletLine[] }> {
    await this.assertPallet(id);
    const { rows, ...meta } = dto;
    const patch: Record<string, unknown> = {};
    for (const key of ['description', 'supplier', 'buyer', 'locationId', 'notes'] as const) {
      if (meta[key] !== undefined) patch[key] = meta[key];
    }
    if (Object.keys(patch).length > 0) await this.pallets.update(id, patch);
    await this.lines.delete({ palletId: id });
    await this.createLinesFromSpec(id, rows ?? []);
    return this.findOne(id);
  }

  // --- Sold workflow ---

  // Sell all or part of one line's quantity. The sold quantity is archived in
  // pallet_sold_lines (snapshotting variant/product/pallet number) and the
  // line shrinks or disappears — pallet totals update automatically because
  // they're always summed live from the lines.
  async sellLine(
    palletId: string,
    lineId: string,
    quantity: number | undefined,
    userId: string,
    salePrice?: number,
  ): Promise<PalletSoldLine> {
    const pallet = await this.assertPallet(palletId);
    const line = await this.lines.findOne({ where: { id: lineId, palletId } });
    if (!line) throw new NotFoundException(`Line ${lineId} not found on this pallet`);
    if (line.quantity <= 0) throw new ConflictException('This line has no quantity left to sell.');

    const qty = Math.min(Math.max(1, Math.trunc(quantity ?? line.quantity)), line.quantity);
    const sold = await this.soldLines.save(
      this.soldLines.create({
        palletId: pallet.id,
        palletNumber: pallet.palletNumber,
        productId: line.productId,
        variant: line.variant,
        quantity: qty,
        saleTotal: salePrice != null && salePrice >= 0 ? salePrice : null,
        unitCost: line.unitCost, // cost snapshot for profit reporting
        soldById: userId,
      }),
    );
    if (qty >= line.quantity) {
      await this.lines.delete(line.id);
    } else {
      await this.lines.update(line.id, { quantity: line.quantity - qty });
    }
    return sold;
  }

  // Sell everything remaining on the pallet in one action; the emptied pallet
  // is stamped shipped (it has physically left).
  async sellPallet(
    palletId: string,
    userId: string,
    saleTotal?: number,
  ): Promise<{ soldLines: number; soldUnits: number }> {
    const pallet = await this.assertPallet(palletId);
    const lines = await this.lines.find({ where: { palletId } });
    const withQty = lines.filter((l) => l.quantity > 0);
    if (withQty.length === 0) throw new ConflictException('This pallet has nothing left to sell.');

    // Optional pallet sale total, split across rows in proportion to quantity
    // (remainder on the last row so the stored sum equals what was entered).
    const totalUnits = withQty.reduce((s, l) => s + l.quantity, 0);
    const priced = saleTotal != null && saleTotal >= 0;
    let allocated = 0;

    let units = 0;
    for (let i = 0; i < withQty.length; i++) {
      const line = withQty[i];
      units += line.quantity;
      let rowTotal: number | null = null;
      if (priced) {
        rowTotal =
          i === withQty.length - 1
            ? Math.round((saleTotal! - allocated) * 100) / 100
            : Math.round(((saleTotal! * line.quantity) / totalUnits) * 100) / 100;
        allocated = Math.round((allocated + rowTotal) * 100) / 100;
      }
      await this.soldLines.save(
        this.soldLines.create({
          palletId: pallet.id,
          palletNumber: pallet.palletNumber,
          productId: line.productId,
          variant: line.variant,
          quantity: line.quantity,
          saleTotal: rowTotal,
          unitCost: line.unitCost,
          soldById: userId,
        }),
      );
    }
    await this.lines.delete({ palletId });
    await this.pallets.update(palletId, { status: PalletStatus.SHIPPED, shippedAt: new Date() });
    return { soldLines: withQty.length, soldUnits: units };
  }

  // The Sold archive for pallet goods — unreturned rows, newest first.
  async findSoldLines(): Promise<PalletSoldLine[]> {
    const rows = await this.soldLines.find({
      where: { returnedAt: IsNull() },
      relations: { soldBy: true, product: true },
      order: { soldAt: 'DESC' },
    });
    return rows.map((r) => {
      if (r.soldBy) r.soldBy = sanitizeUser(r.soldBy) as PalletSoldLine['soldBy'];
      return r;
    });
  }

  // Admin-only return: put the quantity back on a pallet (the original by
  // default). The sold row is stamped returned — kept as audit trail — and
  // drops off the Sold page.
  async returnSoldLine(
    soldId: string,
    targetPalletId: string | null | undefined,
    userId: string,
  ): Promise<PalletSoldLine> {
    const sold = await this.soldLines.findOne({ where: { id: soldId, returnedAt: IsNull() } });
    if (!sold) throw new NotFoundException('Sold record not found (or already returned).');

    const palletId = targetPalletId ?? sold.palletId;
    if (!palletId) {
      throw new BadRequestException(
        'The original pallet no longer exists — choose a destination pallet.',
      );
    }
    const target = await this.assertPallet(palletId);

    // Merge into a matching line on the destination if one exists, else
    // recreate the line from the snapshot.
    const existing = await this.lines.findOne({
      where: sold.productId
        ? { palletId, productId: sold.productId }
        : { palletId, variant: sold.variant, productId: IsNull() },
    });
    if (existing) {
      await this.lines.update(existing.id, { quantity: existing.quantity + sold.quantity });
    } else {
      await this.lines.save(
        this.lines.create({
          palletId,
          productId: sold.productId,
          variant: sold.variant,
          quantity: sold.quantity,
        }),
      );
    }
    // A shipped pallet that just received returned stock is physically back on
    // the floor — reactivate it so it shows under Active again.
    if (target.status === PalletStatus.SHIPPED) {
      await this.pallets.update(palletId, { status: PalletStatus.OPEN, shippedAt: null });
    }
    await this.soldLines.update(soldId, {
      returnedAt: new Date(),
      returnedById: userId,
      returnedToPalletId: palletId,
    });
    return { ...sold, returnedAt: new Date(), returnedById: userId, returnedToPalletId: palletId };
  }

  // Bulk return for the Sold page: palletId omitted -> each row goes back to
  // its own original pallet; given -> all merge into that pallet. Per-row
  // failures (already returned / original pallet gone) are skipped.
  async bulkReturnSoldLines(
    soldIds: string[],
    palletId: string | undefined,
    userId: string,
  ): Promise<{ returned: number; skipped: number }> {
    let returned = 0;
    let skipped = 0;
    for (const id of soldIds) {
      try {
        await this.returnSoldLine(id, palletId, userId);
        returned += 1;
      } catch {
        skipped += 1;
      }
    }
    return { returned, skipped };
  }

  private async createLinesFromSpec(palletId: string, rows: SpecRowDto[]): Promise<void> {
    for (const row of rows) {
      await this.persistLookups(row);
      const product = await this.findOrCreateProduct(row);
      await this.lines.save(
        this.lines.create({
          palletId,
          productId: product.id,
          variant: composeVariant(row) || 'Unspecified',
          quantity: Math.max(0, Math.trunc(row.quantity) || 0),
        }),
      );
    }
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
      ['gen', row.gen],
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
      gen: nz(row.gen),
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
      gen: spec.gen ?? IsNull(),
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

  // Build a formatted .xlsx pallet report. The columns differ by the layout the
  // pallet was created with: Layout 2 (spec) gets a split-column report, every
  // other pallet keeps the original variant report below.
  async generateReport(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const pallet = await this.findOne(id);
    if (pallet.entryLayout === PalletEntryLayout.SPEC) {
      return this.generateSpecReport(pallet);
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ALS Trade Wholesales';
    const ws = wb.addWorksheet('Pallet Report');

    // One entry per column, and everything else derives from these — the title
    // merge and the total-row cells used to be hardcoded to F/3/6, which is
    // silently wrong the moment the column count changes. Same idiom as
    // batches.service.ts.
    const headers = [
      'Pallet number',
      'Manufacturer',
      'Model',
      'Size',
      'Variant',
      'Stand',
      'Quantity',
      'Grade',
      'Unit cost (£)',
      'Line total (£)',
    ];
    const widths = [16, 16, 22, 10, 14, 8, 10, 12, 14, 16];
    ws.columns = widths.map((width) => ({ width }));
    const lastCol = ws.getColumn(headers.length).letter;

    const title = (row: number, text: string, size: number) => {
      ws.mergeCells(`A${row}:${lastCol}${row}`);
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
    headerRow.values = headers;
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
      // The pallet number repeats on every row: the sheet is filtered and
      // sorted downstream, and a row that loses its pallet is unusable.
      row.values = [
        pallet.palletNumber,
        line.manufacturer ?? '',
        line.model ?? '',
        line.size ?? '',
        slugLabel(line.variantType),
        line.stand == null ? '' : line.stand ? 'Yes' : 'No',
        line.quantity,
        gradeLabel(line.grade),
        cost != null ? cost : '',
        lineTotal != null ? lineTotal : '',
      ];
      dataRow += 1;
    }

    const totalRow = ws.getRow(dataRow + 1);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(headers.indexOf('Quantity') + 1).value = pallet.totalQuantity;
    totalRow.getCell(headers.length).value = costTotal > 0 ? costTotal : '';
    totalRow.font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, filename: `${safeFilePart(pallet.palletNumber, pallet.id)}-report.xlsx` };
  }

  // Layout 2 export: each spec attribute in its own column, pulled from the
  // line's linked catalogue product, with a bold header row. No dotted variant,
  // no cost/tier/grade columns — a separate report from Layout 1's.
  private async generateSpecReport(
    pallet: PalletWithTotals & { lines: PalletLine[] },
  ): Promise<{ buffer: Buffer; filename: string }> {
    // findOne doesn't load the product; the spec columns come from it.
    const lines = await this.lines.find({
      where: { palletId: pallet.id },
      relations: ['product'],
      order: { createdAt: 'ASC' },
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ALS Trade Wholesales';
    const ws = wb.addWorksheet('Pallet Report');
    const headers = [
      'Pallet number',
      'Manufacturer',
      'Model',
      'Chassis',
      'CPU',
      'Gen',
      'RAM',
      'Storage',
      'Quantity',
    ];
    const widths = [16, 16, 22, 12, 20, 10, 10, 16, 12];
    ws.columns = widths.map((width) => ({ width }));
    const lastCol = ws.getColumn(headers.length).letter;

    const title = (row: number, text: string, size: number) => {
      ws.mergeCells(`A${row}:${lastCol}${row}`);
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
    headerRow.values = headers;
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
      cell.border = { bottom: { style: 'thin' } };
    });

    let qtyTotal = 0;
    let dataRow = headerRowIndex + 1;
    for (const line of lines) {
      const s = specColumns(line.product, line.variant);
      qtyTotal += line.quantity;
      // The pallet number repeats on every row: the sheet gets filtered and
      // sorted downstream, and a row separated from its pallet is unusable.
      // One row per LINE, exactly as before — quantity stays a count, and a
      // line of 45 is still one row.
      ws.getRow(dataRow).values = [
        pallet.palletNumber,
        s.manufacturer,
        s.model,
        s.chassis,
        s.cpu,
        s.gen,
        s.ram,
        s.storage,
        line.quantity,
      ];
      dataRow += 1;
    }

    const totalRow = ws.getRow(dataRow + 1);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(headers.length).value = qtyTotal;
    totalRow.font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, filename: `${safeFilePart(pallet.palletNumber, pallet.id)}-report.xlsx` };
  }

  async remove(id: string): Promise<void> {
    await this.assertPallet(id);
    await this.pallets.delete(id); // cascades pallet_lines
  }

  // --- lines ---

  async addLine(palletId: string, dto: CreatePalletLineDto): Promise<PalletLine> {
    await this.assertPallet(palletId);
    await this.persistLineLookups(dto);
    // `variant` is NOT NULL and is what the report, the sold snapshot and
    // sold-return matching read, so it is always composed — never left to the
    // client, which no longer sends it.
    const variant = (dto.variant ?? '').trim() || composeLineVariant(dto);
    return this.lines.save(this.lines.create({ ...dto, variant, palletId }));
  }

  async updateLine(palletId: string, lineId: string, dto: UpdatePalletLineDto): Promise<PalletLine> {
    const line = await this.lines.findOne({ where: { id: lineId, palletId } });
    if (!line) throw new NotFoundException(`Line ${lineId} not found on pallet ${palletId}`);
    await this.persistLineLookups(dto);
    // Recompose from the MERGED row, not the dto: the web sends only the field
    // that changed, so composing from the dto alone would blank every other
    // part of the label.
    const merged = { ...line, ...dto };
    const patch: Record<string, unknown> = { ...dto };
    if (dto.variant === undefined) patch.variant = composeLineVariant(merged);
    await this.lines.update(lineId, patch);
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

  // Save any manufacturer/model/size the operator typed so it is offered next
  // time. Model is scoped to its manufacturer, which is what makes picking Dell
  // narrow the model list to Dell's. Mirrors persistLookups for Layout 2.
  private async persistLineLookups(dto: {
    manufacturer?: string | null;
    model?: string | null;
    size?: string | null;
  }): Promise<void> {
    const manufacturer = (dto.manufacturer ?? '').trim();
    const manLookup = manufacturer
      ? await this.lookupsService.findOrCreate('manufacturer', manufacturer)
      : null;
    const model = (dto.model ?? '').trim();
    if (model) await this.lookupsService.findOrCreate('model', model, manLookup?.id ?? null);
    const size = (dto.size ?? '').trim();
    if (size) await this.lookupsService.findOrCreate('size', size);
  }

  // A duplicate pallet number is a user error, not a server fault. Postgres
  // raises 23505 on the unique constraint; without this it surfaced as an
  // opaque 500 with nothing to act on.
  private async saveUnique<T>(save: () => Promise<T>, palletNumber: string): Promise<T> {
    try {
      return await save();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        throw new ConflictException(`Pallet number "${palletNumber}" is already in use.`);
      }
      throw err;
    }
  }

  // Public so the New Pallet form can prefill the next number as a suggestion.
  async nextPalletNumber(): Promise<string> {
    const result = await this.pallets.query(`SELECT nextval('pallet_number_seq') AS n`);
    const n = String(result[0].n).padStart(6, '0');
    return `PALLET-${n}`;
  }

  private async assertPallet(id: string): Promise<Pallet> {
    const pallet = await this.pallets.findOne({ where: { id } });
    if (!pallet) throw new NotFoundException(`Pallet ${id} not found`);
    return pallet;
  }
}

// Empty/whitespace -> null, so blank spec cells are stored (and matched) as NULL.
function nz(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

// The six spec fields for one Layout 2 export row, taken from the linked
// catalogue product (RAM rendered back as "8 GB"). If the product was somehow
// unlinked, fall back to the composed variant label so no data is lost.
function specColumns(
  product: Product | null,
  variant: string,
): {
  manufacturer: string;
  model: string;
  chassis: string;
  cpu: string;
  gen: string;
  ram: string;
  storage: string;
} {
  if (product) {
    return {
      manufacturer: product.manufacturer ?? '',
      model: product.model ?? '',
      chassis: product.chassis ?? '',
      cpu: product.cpu ?? '',
      gen: product.gen ?? '',
      ram: ramLabel(product.ramGb),
      storage: product.storage ?? '',
    };
  }
  return {
    manufacturer: '',
    model: variant ?? '',
    chassis: '',
    cpu: '',
    gen: '',
    ram: '',
    storage: '',
  };
}

// "8 GB" / "16GB" -> 8 / 16; null when there's no number.
// products.ram_gb is an int, so "None" cannot be stored as text the way
// products.cpu stores it. 0 is the sentinel for "explicitly no RAM"; NULL keeps
// its existing meaning of "not specified". That distinction is why 'None' is
// checked before the digits — "None" contains no digits, but neither does an
// empty cell, and they are not the same answer.
export const RAM_NONE = 0;

export function parseRamGb(ram: string | null | undefined): number | null {
  const raw = (ram ?? '').trim();
  if (/^none$/i.test(raw)) return RAM_NONE;
  const m = raw.match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// The inverse of parseRamGb, for anything rendering a stored value back.
export function ramLabel(ramGb: number | null | undefined, unit = ' GB'): string {
  if (ramGb == null) return '';
  return ramGb === RAM_NONE ? 'None' : `${ramGb}${unit}`;
}

// A readable one-line label for a spec row, used as the pallet line's variant
// and the product name.
function composeVariant(row: {
  manufacturer?: string | null;
  model?: string | null;
  chassis?: string | null;
  cpu?: string | null;
  gen?: string | null;
  ram?: string | null;
  storage?: string | null;
}): string {
  return [row.manufacturer, row.model, row.chassis, row.cpu, row.gen, row.ram, row.storage]
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join(' · ');
}

// Pallet numbers are typed now, and the report filename is interpolated straight
// into an HTTP Content-Disposition header. A quote truncates that header, a
// slash or semicolon corrupts it, and a newline makes Node throw
// ERR_INVALID_CHAR — a 500 on export for a pallet that is otherwise fine.
export function safeFilePart(value: string, fallback: string): string {
  const clean = (value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || fallback;
}

// The display label for a Layout 1 line, built from its spec fields. Same
// ' · ' join as composeVariant so both layouts read alike in the sold archive.
// Falls back to 'Unspecified' because pallet_lines.variant is NOT NULL and a
// row with nothing filled in yet must still save.
export function composeLineVariant(line: {
  manufacturer?: string | null;
  model?: string | null;
  size?: string | null;
  variantType?: string | null;
  stand?: boolean | null;
}): string {
  return (
    [
      line.manufacturer,
      line.model,
      line.size,
      slugLabel(line.variantType ?? null),
      line.stand === true ? 'Stand' : line.stand === false ? 'No stand' : null,
    ]
      .map((x) => (x ?? '').trim())
      .filter(Boolean)
      .join(' · ') || 'Unspecified'
  );
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
