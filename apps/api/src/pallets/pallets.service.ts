import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  FindOptionsWhere,
  In,
  IsNull,
  Repository,
} from 'typeorm';
import * as ExcelJS from 'exceljs';
import { Pallet, PalletStatus, PalletEntryLayout } from './pallet.entity';
import { PalletLine } from './pallet-line.entity';
import { PalletSoldLine } from './pallet-sold-line.entity';
import { PalletMerge } from './pallet-merge.entity';
import { Product, ProductTrackingType } from '../products/product.entity';
import { CreatePalletDto } from './dto/create-pallet.dto';
import { UpdatePalletDto } from './dto/update-pallet.dto';
import { CreatePalletLineDto } from './dto/create-pallet-line.dto';
import { UpdatePalletLineDto } from './dto/update-pallet-line.dto';
import { CreatePalletSpecDto, SpecRowDto } from './dto/create-pallet-spec.dto';
import { MergePalletsDto } from './dto/merge-pallets.dto';
import { LookupsService } from '../lookups/lookups.service';
import { ActivityService } from '../activity/activity.service';
import { sanitizeUser } from '../users/sanitize-user';
import { Asset, AssetStockStatus } from '../assets/asset.entity';
import { AssetEventType, AssetHistory } from '../assets/asset-history.entity';
import { Batch } from '../batches/batch.entity';
import {
  isScopedManager,
  managerCanAccessBatch,
  type RequestUser,
} from '../common/ownership';

export interface PalletWithTotals extends Pallet {
  totalQuantity: number;
  lineCount: number;
}

export interface MergedFromSummary {
  id: string | null; // null once the original is deleted; the number survives
  palletNumber: string;
  units: number;
  lines: number;
  mergedAt: Date;
}

// A device row on an asset pallet's detail page — a projection, never the
// raw entity (movedToPalletBy is a User relation and must not leak a hash).
export interface PalletAssetRow {
  id: string;
  unitId: string | null;
  tag: string;
  name: string;
  // The device's captured configuration — what the buyer of a serialized
  // pallet is actually buying. Sourced from the asset's hardware_profile
  // (the capture tool's normalised snapshot); null where a device was
  // hand-entered without one.
  manufacturer: string | null;
  model: string | null;
  deviceType: string | null;
  serialNumber: string | null;
  cpu: string | null;
  ramGb: number | null;
  storage: string | null;
  screenSize: string | null;
  batteryHealth: string | null;
  conditionGrade: string | null;
  auditStatus: string | null;
  movedToPalletAt: Date | null;
  movedToPalletByName: string | null;
  // Set once the device sold WITH the pallet (whole-pallet sale keeps the
  // link — the manifest of what shipped is the pallet's record). Individual
  // sales off a live pallet clear the link instead, so an OPEN pallet never
  // shows sold rows.
  soldAt: Date | null;
  salePrice: number | null;
}

// "256GB NVMe + 1TB HDD" from the profile's drive list — same composition the
// audit summary rows use, extended across every drive rather than the first.
function composeStorage(profile: Asset['hardwareProfile']): string | null {
  const drives = profile?.storage ?? [];
  const parts = drives
    .map((d) => [d.capacity, d.type].filter(Boolean).join(' '))
    .filter((s) => s.length > 0);
  return parts.length ? parts.join(' + ') : null;
}

export interface PalletDetail extends PalletWithTotals {
  lines: PalletLine[];
  // Populated for entryLayout='asset' pallets; [] otherwise. An asset pallet
  // has no lines and a line pallet has no assets — one or the other, never
  // both (the modelling decision behind the whole Goods In allocation).
  assets: PalletAssetRow[];
  // Which pallets were merged INTO this one.
  mergedFrom: MergedFromSummary[];
  // Where this pallet's stock went, if it was itself merged away.
  mergedInto: { id: string; palletNumber: string; mergedAt: Date } | null;
  // What this pallet contributed, as it now sits on its successor. Only
  // populated for a merged pallet — this is the "historical record" its own
  // page still shows once its stock has moved.
  contributedLines: PalletLine[];
}

// A ceiling on the multi-pallet export, so a runaway request can't ask the
// server to build a workbook out of the entire table. Far above any real
// selection — the warehouse picks a handful, or a filtered page of them.
const MAX_EXPORT_PALLETS = 500;

// Ids arrive from a request body, and an id that isn't a uuid reaches Postgres
// as a failed cast — a 500 for what is really a bad request.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PalletsService {
  constructor(
    @InjectRepository(Pallet) private pallets: Repository<Pallet>,
    @InjectRepository(PalletLine) private lines: Repository<PalletLine>,
    @InjectRepository(PalletSoldLine)
    private soldLines: Repository<PalletSoldLine>,
    @InjectRepository(PalletMerge) private merges: Repository<PalletMerge>,
    @InjectRepository(Product) private products: Repository<Product>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetHistory) private assetHistory: Repository<AssetHistory>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
    private lookupsService: LookupsService,
    private activity: ActivityService,
  ) {}

  async findAll(): Promise<PalletWithTotals[]> {
    const pallets = await this.pallets.find({
      relations: ['location'],
      order: { createdAt: 'DESC' },
    });
    return this.withTotals(pallets);
  }

  async findOne(id: string): Promise<PalletDetail> {
    const pallet = await this.pallets.findOne({
      where: { id },
      relations: ['location'],
    });
    if (!pallet) throw new NotFoundException(`Pallet ${id} not found`);
    const [withTotals] = await this.withTotals([pallet]);
    // product is included so the Layout 2 grid editor can rebuild its rows
    // (manufacturer/model/…/gen) from the linked catalogue entries.
    const lines = await this.lines.find({
      where: { palletId: id },
      relations: { product: true },
      order: { createdAt: 'ASC' },
    });

    // Both sides of the merge story, from pallet_merges rather than from the
    // lines — read it off the lines and "Created from: PALLET-a" vanishes the
    // moment the last line originating from PALLET-a is sold. Two indexed
    // point-lookups, and both return nothing for the ordinary unmerged pallet.
    const [from, into] = await Promise.all([
      this.merges.find({
        where: { resultPalletId: id },
        order: { mergedAt: 'ASC' },
      }),
      this.merges.findOne({
        where: { sourcePalletId: id },
        relations: ['resultPallet'],
      }),
    ]);

    // What this pallet contributed, now living on the pallet that replaced it.
    // Derived, so there is no second copy to drift out of step.
    const contributedLines =
      pallet.status === PalletStatus.MERGED
        ? await this.lines.find({
            where: { sourcePalletId: id },
            relations: { product: true },
            order: { createdAt: 'ASC' },
          })
        : [];

    // The device rows an asset pallet holds. [] for line pallets — the query
    // is skipped entirely rather than run empty.
    const assetRows: PalletAssetRow[] =
      pallet.entryLayout === PalletEntryLayout.ASSET
        ? ((await this.assetRowsByPallet([id])).get(id) ?? [])
        : [];

    return {
      ...withTotals,
      assets: assetRows,
      lines,
      mergedFrom: from.map((m) => ({
        id: m.sourcePalletId,
        palletNumber: m.sourcePalletNumber,
        units: m.unitsContributed,
        lines: m.linesContributed,
        mergedAt: m.mergedAt,
      })),
      mergedInto: into?.resultPallet
        ? {
            id: into.resultPallet.id,
            palletNumber: into.resultPallet.palletNumber,
            mergedAt: into.mergedAt,
          }
        : null,
      contributedLines,
    };
  }

  async create(dto: CreatePalletDto): Promise<Pallet> {
    // Destructure the typed number OUT of the dto before spreading. Spreading
    // the dto and then overriding palletNumber (as this did) silently discards
    // whatever the operator typed — the whole feature looks wired up and every
    // pallet still comes out PALLET-000xxx.
    const { palletNumber: typed, ...rest } = dto;
    const palletNumber =
      (typed ?? '').trim() || (await this.nextPalletNumber());
    return this.saveUnique(
      () => this.pallets.save(this.pallets.create({ ...rest, palletNumber })),
      palletNumber,
    );
  }

  // Layout 2 create: one pallet + a line per spec row. Each row find-or-creates
  // a catalogue Product (so specs are reusable and searchable), and the line
  // carries a composed "variant" label so it displays/reports like any other.
  async createFromSpec(dto: CreatePalletSpecDto): Promise<Pallet> {
    const { rows, palletNumber: typed, ...meta } = dto;
    const palletNumber =
      (typed ?? '').trim() || (await this.nextPalletNumber());
    const pallet = await this.saveUnique(
      () =>
        this.pallets.save(
          this.pallets.create({
            ...meta,
            palletNumber,
            entryLayout: PalletEntryLayout.SPEC,
          }),
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
    const specTarget = await this.assertPallet(id);
    // The spec editor saves by deleting every line and recreating from the
    // grid. An asset pallet has no grid — letting this run would silently
    // relabel it Layout 2 while its devices still point at it.
    if (specTarget.entryLayout === PalletEntryLayout.ASSET) {
      throw new ConflictException(
        `${specTarget.palletNumber} holds serialized devices — it has no spec grid to edit.`,
      );
    }
    const { rows, ...meta } = dto;
    const patch: Record<string, unknown> = {};
    for (const key of [
      'description',
      'supplier',
      'buyer',
      'locationId',
      'notes',
    ] as const) {
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
    if (!line)
      throw new NotFoundException(`Line ${lineId} not found on this pallet`);
    if (line.quantity <= 0)
      throw new ConflictException('This line has no quantity left to sell.');

    const qty = Math.min(
      Math.max(1, Math.trunc(quantity ?? line.quantity)),
      line.quantity,
    );
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
    if (pallet.entryLayout === PalletEntryLayout.ASSET) {
      return this.sellAssetPallet(pallet, userId, saleTotal);
    }
    // Defensive: a line pallet must never hold devices (one or the other,
    // never both) — refuse rather than ship a pallet whose devices stay
    // in stock and double-count.
    const strayDevices = await this.assets.count({ where: { palletId } });
    if (strayDevices > 0) {
      throw new ConflictException(
        `${pallet.palletNumber} unexpectedly holds ${strayDevices} serialized device${
          strayDevices === 1 ? '' : 's'
        } — remove them before selling it as a line pallet.`,
      );
    }
    const lines = await this.lines.find({ where: { palletId } });
    const withQty = lines.filter((l) => l.quantity > 0);
    if (withQty.length === 0)
      throw new ConflictException('This pallet has nothing left to sell.');

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
            : Math.round(((saleTotal! * line.quantity) / totalUnits) * 100) /
              100;
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
    await this.pallets.update(palletId, {
      status: PalletStatus.SHIPPED,
      shippedAt: new Date(),
    });
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
      if (r.soldBy)
        r.soldBy = sanitizeUser(r.soldBy) as PalletSoldLine['soldBy'];
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
    const sold = await this.soldLines.findOne({
      where: { id: soldId, returnedAt: IsNull() },
    });
    if (!sold)
      throw new NotFoundException(
        'Sold record not found (or already returned).',
      );

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
      await this.lines.update(existing.id, {
        quantity: existing.quantity + sold.quantity,
      });
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
      await this.pallets.update(palletId, {
        status: PalletStatus.OPEN,
        shippedAt: null,
      });
    }
    await this.soldLines.update(soldId, {
      returnedAt: new Date(),
      returnedById: userId,
      returnedToPalletId: palletId,
    });
    return {
      ...sold,
      returnedAt: new Date(),
      returnedById: userId,
      returnedToPalletId: palletId,
    };
  }

  // Bulk return for the Sold page: palletId omitted -> each row goes back to
  // its own original pallet; given -> all merge into that pallet. Per-row
  // failures (already returned / original pallet gone) are skipped.
  async bulkReturnSoldLines(
    soldIds: string[],
    palletId: string | undefined,
    userId: string,
  ): Promise<{ returned: number; skipped: number; reasons: string[] }> {
    let returned = 0;
    let skipped = 0;
    // Why, not just how many. "3 skipped" is unactionable, and merging made the
    // most likely reason a precise one worth passing on: the original pallet
    // was merged, and the message names the pallet to return to instead.
    const reasons = new Set<string>();
    for (const id of soldIds) {
      try {
        await this.returnSoldLine(id, palletId, userId);
        returned += 1;
      } catch (err) {
        skipped += 1;
        const message = (err as { message?: string })?.message;
        if (message) reasons.add(message);
      }
    }
    return { returned, skipped, reasons: [...reasons] };
  }

  private async createLinesFromSpec(
    palletId: string,
    rows: SpecRowDto[],
  ): Promise<void> {
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
      await this.lookupsService.findOrCreate(
        'model',
        row.model!,
        manLookup?.id ?? null,
      );
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
    // Frozen once merged — including its status, so it can't be quietly
    // reopened to hide the merge.
    await this.assertNotMerged(before);
    // And no manual route INTO merged. UpdatePalletDto is a PartialType of
    // CreatePalletDto, whose @IsEnum(PalletStatus) started accepting 'merged'
    // the moment the TS enum gained it — merged is reachable only by merging.
    if (dto.status === PalletStatus.MERGED) {
      throw new BadRequestException(
        'A pallet becomes merged by merging it, not by setting its status.',
      );
    }

    // Stamp the ship time on the transition into 'shipped'; clear it if the
    // pallet is brought back to open/ready.
    const patch: Partial<Pallet> = { ...dto };
    if (
      dto.status === PalletStatus.SHIPPED &&
      before.status !== PalletStatus.SHIPPED
    ) {
      patch.shippedAt = new Date();
    } else if (dto.status && dto.status !== PalletStatus.SHIPPED) {
      patch.shippedAt = null;
    }

    await this.pallets.update(id, patch);
    return (
      await this.withTotals([
        await this.pallets.findOneOrFail({
          where: { id },
          relations: ['location'],
        }),
      ])
    )[0];
  }

  // Build a formatted .xlsx pallet report. The columns differ by the layout the
  // pallet was created with: Layout 2 (spec) gets a split-column report, every
  // other pallet keeps the original variant report below.
  async generateReport(
    id: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const pallet = await this.findOne(id);
    if (pallet.entryLayout === PalletEntryLayout.SPEC) {
      return this.generateSpecReport(pallet);
    }
    if (pallet.entryLayout === PalletEntryLayout.ASSET) {
      return this.generateAssetReport(pallet);
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ALS Trade Wholesales';
    const ws = wb.addWorksheet('Pallet Report');

    // One entry per column, and everything else derives from these — the title
    // merge and the total-row cells used to be hardcoded to F/3/6, which is
    // silently wrong the moment the column count changes. Same idiom as
    // batches.service.ts.
    const headers = VARIANT_HEADERS;
    const widths = VARIANT_WIDTHS;
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
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEFEFEF' },
      };
      cell.border = { bottom: { style: 'thin' } };
    });

    let costTotal = 0;
    let dataRow = headerRowIndex + 1;
    for (const line of pallet.lines) {
      const lineTotal = palletLineTotal(line);
      if (lineTotal != null) costTotal += lineTotal;
      ws.getRow(dataRow).values = variantRow(pallet.palletNumber, line);
      dataRow += 1;
    }

    const totalRow = ws.getRow(dataRow + 1);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(headers.indexOf('Quantity') + 1).value =
      pallet.totalQuantity;
    totalRow.getCell(headers.length).value = costTotal > 0 ? costTotal : '';
    totalRow.font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return {
      buffer,
      filename: `${safeFilePart(pallet.palletNumber, pallet.id)}-report.xlsx`,
    };
  }

  // Layout 2 export: each spec attribute in its own column, pulled from the
  // line's linked catalogue product, with a bold header row. No dotted variant,
  // no cost/tier/grade columns — a separate report from Layout 1's.
  // The per-pallet costing sheet was removed: costing is being rebuilt as one
  // general system rather than a document hanging off a single pallet. The
  // landscape renderer is recoverable from git history at 56c23d9 if the new
  // system wants the same layout.

  // Asset-pallet export: one row per DEVICE — serial identity is the point,
  // so the columns are the device's, not a line's. Header/width arrays are
  // pinned by test like the other two layouts.
  private async generateAssetReport(
    pallet: PalletDetail,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ALS Trade Wholesales';
    const ws = wb.addWorksheet('Pallet Report');

    const headers = ASSET_HEADERS;
    const widths = ASSET_WIDTHS;
    ws.columns = widths.map((width) => ({ width }));
    const lastCol = ws.getColumn(headers.length).letter;

    const title = (row: number, text: string, size: number) => {
      ws.mergeCells(`A${row}:${lastCol}${row}`);
      const cell = ws.getCell(`A${row}`);
      cell.value = text;
      cell.font = { size, bold: true };
    };
    title(1, 'ALS Trade Wholesales', 16);
    title(2, 'Pallet Report — serialized devices', 12);

    const meta: [string, string | number][] = [
      ['Date generated', new Date().toLocaleString('en-GB')],
      ['Pallet number', pallet.palletNumber],
      ['Description', pallet.description ?? '—'],
      ['Location', pallet.location?.name ?? '—'],
      ['Status', pallet.status],
      ['Total devices', pallet.totalQuantity],
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
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEFEFEF' },
      };
      cell.border = { bottom: { style: 'thin' } };
    });

    let dataRow = headerRowIndex + 1;
    for (const a of pallet.assets) {
      ws.getRow(dataRow).values = assetReportRow(pallet.palletNumber, a);
      dataRow += 1;
    }

    const totalRow = ws.getRow(dataRow + 1);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(headers.length).value = pallet.totalQuantity;
    totalRow.font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return {
      buffer,
      filename: `${safeFilePart(pallet.palletNumber, pallet.id)}-report.xlsx`,
    };
  }

  private async generateSpecReport(
    pallet: PalletWithTotals & { lines: PalletLine[] },
  ): Promise<{ buffer: Buffer; filename: string }> {
    // findOne loads the product now, so this re-query is redundant — kept only
    // because it is this report's own read and costs one query for one pallet.
    // Do NOT copy it into a loop over pallets: that is an N+1. The multi-pallet
    // export batches its line load instead.
    const lines = await this.lines.find({
      where: { palletId: pallet.id },
      relations: ['product'],
      order: { createdAt: 'ASC' },
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ALS Trade Wholesales';
    const ws = wb.addWorksheet('Pallet Report');
    const headers = SPEC_HEADERS;
    const widths = SPEC_WIDTHS;
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
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEFEFEF' },
      };
      cell.border = { bottom: { style: 'thin' } };
    });

    let qtyTotal = 0;
    let dataRow = headerRowIndex + 1;
    for (const line of lines) {
      qtyTotal += line.quantity;
      ws.getRow(dataRow).values = specRow(pallet.palletNumber, line);
      dataRow += 1;
    }

    const totalRow = ws.getRow(dataRow + 1);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(headers.length).value = qtyTotal;
    totalRow.font = { bold: true };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return {
      buffer,
      filename: `${safeFilePart(pallet.palletNumber, pallet.id)}-report.xlsx`,
    };
  }

  // --- multi-pallet export ---

  // The workspace exports a SELECTION, and the single-pallet report cannot
  // express one: it keeps supplier, buyer, description, location and status in
  // a meta block above the table, and a meta block has nowhere to go once
  // there are twenty pallets in the file. So the selection splits in two:
  //
  //   Summary   one row per pallet, carrying everything that used to sit in
  //             the meta block, plus that pallet's totals.
  //   Layout 1  the item rows, under exactly the headers that layout's own
  //   Layout 2  report already uses.
  //
  // Keeping the item sheets column-for-column identical to the single-pallet
  // reports is the point. Anyone who reads those reads these, and nothing
  // downstream that parses one has to learn a second shape. Pallet number is
  // column A on both — required so a row that gets sorted or filtered away
  // from its neighbours is still attributable, and it doubles as the join back
  // to Summary.
  //
  // A mixed selection produces both sheets rather than one union sheet padded
  // with blanks; a sheet only appears if the selection contains that layout.
  async generateMultiReport(
    ids: string[],
  ): Promise<{ buffer: Buffer; filename: string }> {
    const wanted = [...new Set(ids)].filter((id) => UUID_RE.test(id));
    if (wanted.length === 0) {
      throw new BadRequestException('Select at least one pallet to export.');
    }
    if (wanted.length > MAX_EXPORT_PALLETS) {
      throw new BadRequestException(
        `Too many pallets selected — export up to ${MAX_EXPORT_PALLETS} at a time.`,
      );
    }

    const found = await this.pallets.find({
      where: { id: In(wanted) },
      relations: ['location'],
    });
    if (found.length === 0) {
      throw new NotFoundException(
        'None of the selected pallets could be found.',
      );
    }

    // Pallet number ascending rather than selection order: a spreadsheet is
    // read top to bottom and the numbers are sequential, so this is the order
    // in which someone can find a pallet by eye.
    const pallets = (await this.withTotals(found)).sort((a, b) =>
      a.palletNumber.localeCompare(b.palletNumber),
    );

    // One query for every line in the selection — product included because the
    // Layout 2 columns are derived from it.
    const lines = await this.lines.find({
      where: { palletId: In(pallets.map((p) => p.id)) },
      relations: { product: true },
      order: { createdAt: 'ASC' },
    });
    const byPallet = new Map<string, PalletLine[]>();
    for (const line of lines) {
      const bucket = byPallet.get(line.palletId);
      if (bucket) bucket.push(line);
      else byPallet.set(line.palletId, [line]);
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ALS Trade Wholesales';
    const generated = new Date().toLocaleString('en-GB');
    const isSpec = (p: PalletWithTotals) =>
      p.entryLayout === PalletEntryLayout.SPEC;
    const isAsset = (p: PalletWithTotals) =>
      p.entryLayout === PalletEntryLayout.ASSET;
    const layout1 = pallets.filter((p) => !isSpec(p) && !isAsset(p));
    const layout2 = pallets.filter(isSpec);
    // Serialized pallets get their own sheet: their rows are DEVICES with the
    // full per-unit configuration, not quantity lines — transferring whole
    // Goods In batches made them the common case, so the bulk export must
    // carry them rather than refuse the selection.
    const assetPallets2 = pallets.filter(isAsset);
    const deviceRows = await this.assetRowsByPallet(assetPallets2.map((p) => p.id));
    const deviceTotal = [...deviceRows.values()].reduce((n, r) => n + r.length, 0);

    // The sheet holding the actual stock is called "Items". It used to be named
    // after the entry layout that built the pallet — an internal idea from the
    // New Pallet chooser that means nothing to someone opening a spreadsheet,
    // and it led a reader to conclude the item data was missing entirely when
    // it was sitting on the next tab.
    //
    // The two layouts genuinely cannot share one sheet: Layout 1 keeps its spec
    // on the line and carries cost, Layout 2 reads its spec off the linked
    // catalogue product and has no cost column at all. So a mixed selection
    // gets one named sheet each, and the far more common single-layout
    // selection gets a sheet called simply "Items".
    const kindsPresent =
      (layout1.length > 0 ? 1 : 0) +
      (layout2.length > 0 ? 1 : 0) +
      (assetPallets2.length > 0 ? 1 : 0);
    const mixed = kindsPresent > 1;
    const itemSheet = (spec: boolean) =>
      mixed ? `Items (${spec ? 'Layout 2' : 'Layout 1'})` : 'Items';
    const deviceSheetName = mixed ? 'Items (Serialized)' : 'Items';

    // A merged pallet's lines remember which pallet they came from, and an
    // export of one has to show it or the traceability is only in the database.
    // The column appears only when a line actually carries provenance, so an
    // ordinary export is unchanged and column-for-column identical to the
    // single-pallet report.
    const withSource = (rows: PalletLine[]) =>
      rows.some((l) => l.sourcePalletNumber);
    const addSourceCol = <T>(cells: T[], value: T): T[] => [
      cells[0],
      value,
      ...cells.slice(1),
    ];

    // The same furniture the single-pallet reports build: title, subtitle, a
    // short meta block, then a shaded header row.
    const startSheet = (
      name: string,
      subtitle: string,
      headers: string[],
      widths: number[],
      meta: [string, string | number][],
    ) => {
      const ws = wb.addWorksheet(name);
      ws.columns = widths.map((width) => ({ width }));
      const lastCol = ws.getColumn(headers.length).letter;

      const title = (row: number, text: string, size: number) => {
        ws.mergeCells(`A${row}:${lastCol}${row}`);
        const cell = ws.getCell(`A${row}`);
        cell.value = text;
        cell.font = { size, bold: true };
      };
      title(1, 'ALS Trade Wholesales', 16);
      title(2, subtitle, 12);

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
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFEFEFEF' },
        };
        cell.border = { bottom: { style: 'thin' } };
      });
      return { ws, firstDataRow: headerRowIndex + 1 };
    };

    // ITEM SHEETS ARE CREATED FIRST, and the workbook opens on the first one.
    // The stock is what someone opens this file for; a Summary-first workbook
    // depends on the reader finding a second tab, and a reader whose Excel has
    // the tab bar hidden — or who is looking at a preview pane — never will.
    // Twice a full item sheet was reported as missing data because of it.

    if (layout1.length > 0) {
      const rows1 = layout1.flatMap((p) => byPallet.get(p.id) ?? []);
      const src1 = withSource(rows1);
      const headers = src1
        ? addSourceCol(VARIANT_HEADERS, 'Original pallet')
        : VARIANT_HEADERS;
      const { ws, firstDataRow } = startSheet(
        itemSheet(false),
        'Pallet Export — Layout 1 items',
        headers,
        src1 ? addSourceCol(VARIANT_WIDTHS, 16) : VARIANT_WIDTHS,
        [
          ['Date generated', generated],
          ['Pallets included', layout1.length],
          ['Item lines', rows1.length],
        ],
      );

      let row = firstDataRow;
      let qtyTotal = 0;
      let costTotal = 0;
      for (const pallet of layout1) {
        for (const line of byPallet.get(pallet.id) ?? []) {
          const lineTotal = palletLineTotal(line);
          if (lineTotal != null) costTotal += lineTotal;
          qtyTotal += line.quantity;
          const cells = variantRow(pallet.palletNumber, line);
          ws.getRow(row).values = src1
            ? addSourceCol(cells, line.sourcePalletNumber ?? '')
            : cells;
          row += 1;
        }
      }

      const totalRow = ws.getRow(row + 1);
      totalRow.getCell(1).value = 'Total';
      totalRow.getCell(headers.indexOf('Quantity') + 1).value = qtyTotal;
      totalRow.getCell(headers.length).value = costTotal > 0 ? costTotal : '';
      totalRow.font = { bold: true };
    }

    if (layout2.length > 0) {
      const rows2 = layout2.flatMap((p) => byPallet.get(p.id) ?? []);
      const src2 = withSource(rows2);
      const headers = src2
        ? addSourceCol(SPEC_HEADERS, 'Original pallet')
        : SPEC_HEADERS;
      const { ws, firstDataRow } = startSheet(
        itemSheet(true),
        'Pallet Export — Layout 2 items',
        headers,
        src2 ? addSourceCol(SPEC_WIDTHS, 16) : SPEC_WIDTHS,
        [
          ['Date generated', generated],
          ['Pallets included', layout2.length],
          ['Item lines', rows2.length],
        ],
      );

      let row = firstDataRow;
      let qtyTotal = 0;
      for (const pallet of layout2) {
        for (const line of byPallet.get(pallet.id) ?? []) {
          qtyTotal += line.quantity;
          const cells = specRow(pallet.palletNumber, line);
          ws.getRow(row).values = src2
            ? addSourceCol(cells, line.sourcePalletNumber ?? '')
            : cells;
          row += 1;
        }
      }

      const totalRow = ws.getRow(row + 1);
      totalRow.getCell(1).value = 'Total';
      totalRow.getCell(headers.length).value = qtyTotal;
      totalRow.font = { bold: true };
    }

    if (assetPallets2.length > 0) {
      const { ws, firstDataRow } = startSheet(
        deviceSheetName,
        'Pallet Export — serialized devices',
        ASSET_HEADERS,
        ASSET_WIDTHS,
        [
          ['Date generated', generated],
          ['Pallets included', assetPallets2.length],
          ['Devices', deviceTotal],
        ],
      );

      let row = firstDataRow;
      for (const pallet of assetPallets2) {
        for (const device of deviceRows.get(pallet.id) ?? []) {
          ws.getRow(row).values = assetReportRow(pallet.palletNumber, device);
          row += 1;
        }
      }

      const totalRow = ws.getRow(row + 1);
      totalRow.getCell(1).value = 'Total';
      totalRow.getCell(ASSET_HEADERS.length).value = deviceTotal;
      totalRow.font = { bold: true };
    }

    // Summary — the per-pallet facts, once each.
    {
      const headers = [
        'Pallet number',
        'Created',
        'Layout',
        'Supplier',
        'Buyer',
        'Description',
        'Location',
        'Status',
        'Lines',
        'Total items',
      ];
      const widths = [16, 14, 10, 20, 20, 32, 18, 12, 8, 12];
      const totalLines = pallets.reduce((n, p) => n + p.lineCount, 0);
      const sheetNames = [
        ...(layout1.length ? [itemSheet(false)] : []),
        ...(layout2.length ? [itemSheet(true)] : []),
        ...(assetPallets2.length ? [deviceSheetName] : []),
      ];
      const { ws, firstDataRow } = startSheet(
        'Summary',
        'Pallet Export',
        headers,
        widths,
        [
          ['Date generated', generated],
          ['Pallets included', pallets.length],
          // Said outright, because a reader who does not notice the second tab
          // sees only totals here and reasonably concludes the stock is missing.
          [
            'Item detail',
            `${totalLines} item line${totalLines === 1 ? '' : 's'}${
              deviceTotal > 0 ? ` and ${deviceTotal} device${deviceTotal === 1 ? '' : 's'}` : ''
            } on the ${sheetNames.map((n) => `"${n}"`).join(' and ')} sheet${sheetNames.length > 1 ? 's' : ''}`,
          ],
        ],
      );

      const createdCol = headers.indexOf('Created') + 1;
      let row = firstDataRow;
      for (const p of pallets) {
        ws.getRow(row).values = [
          p.palletNumber,
          londonDate(p.createdAt) ?? '',
          layoutName(p.entryLayout),
          p.supplier ?? '',
          p.buyer ?? '',
          p.description ?? '',
          p.location?.name ?? '',
          p.status,
          p.lineCount,
          p.totalQuantity,
        ];
        // Format the CELL, not the column. Formatting the whole column also
        // hit the meta block above, which writes its values into column B —
        // so "Pallets included: 2" rendered as 02/01/1900.
        ws.getRow(row).getCell(createdCol).numFmt = 'dd/mm/yyyy';
        row += 1;
      }

      const totalRow = ws.getRow(row + 1);
      totalRow.getCell(1).value = 'Total';
      totalRow.getCell(headers.indexOf('Lines') + 1).value = pallets.reduce(
        (n, p) => n + p.lineCount,
        0,
      );
      totalRow.getCell(headers.length).value = pallets.reduce(
        (n, p) => n + p.totalQuantity,
        0,
      );
      totalRow.font = { bold: true };
    }

    // Say which sheet the file opens on rather than leaving it to the reader's
    // Excel to decide.
    wb.views = [
      {
        activeTab: 0,
        x: 0,
        y: 0,
        width: 20000,
        height: 20000,
        firstSheet: 0,
        visibility: 'visible',
      },
    ];

    const stamp = new Date().toISOString().slice(0, 10);
    return {
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
      filename: `pallets-${stamp}.xlsx`,
    };
  }

  // --- merge ----------------------------------------------------------------

  // The counts behind a merge, so the confirmation dialog can state real
  // numbers instead of guessing, and the button can be disabled WITH A REASON
  // before anyone clicks. Same validator as the merge, but blockers are
  // returned rather than thrown — the workspace needs to explain, not fail.
  // Note it does NOT suggest a pallet number: nextval is non-transactional, so
  // every preview would burn one. The dialog prefills from the existing
  // /pallets/next-number endpoint, exactly as the New Pallet form does.
  async previewMerge(palletIds: string[]): Promise<{
    sources: MergeCandidate[];
    blockers: string[];
  }> {
    const ids = [...new Set(palletIds)].filter((id) => UUID_RE.test(id));
    if (ids.length < 2) {
      return { sources: [], blockers: ['Merge requires exactly 2 pallets.'] };
    }
    if (ids.length > 2) {
      return {
        sources: [],
        blockers: ['Please select exactly 2 pallets to merge.'],
      };
    }

    const found = await this.pallets.find({ where: { id: In(ids) } });
    const sources = await this.toMergeCandidates(found);
    const blockers = mergeBlockers(sources);
    const missing = ids.length - found.length;
    if (missing > 0) {
      blockers.unshift(`${missing} of the selected pallets no longer exist.`);
    }

    return { sources, blockers };
  }

  // Merge two or more pallets onto a NEW pallet.
  //
  // The lines MOVE; they are never copied. A pallet_lines row is a claim on
  // physical stock, and every consumer in the system sums that table with no
  // status filter and no join back to pallets — so a copied line would be
  // sellable, invoiceable and countable twice, forever. Moving keeps
  // SUM(quantity) globally identical, which is why no report, valuation or
  // roll-up needed touching for this feature.
  //
  // The originals are kept as records, not as stock: status MERGED, zero lines,
  // and every mutating path refuses them.
  async mergePallets(
    dto: MergePalletsDto,
    userId: string | null,
  ): Promise<PalletWithTotals & { lines: PalletLine[] }> {
    const ids = [...new Set(dto.palletIds)];
    if (ids.length !== 2) {
      throw new BadRequestException(
        ids.length < 2
          ? 'Merge requires exactly 2 pallets.'
          : 'Please select exactly 2 pallets to merge.',
      );
    }

    // Taken OUTSIDE the transaction: sequences are non-transactional by design,
    // so a rolled-back merge simply burns a number, exactly as a failed create
    // does today. Reserving it inside would not make it recyclable.
    const palletNumber =
      (dto.palletNumber ?? '').trim() || (await this.nextPalletNumber());

    const newPalletId = await this.pallets.manager.transaction(async (m) => {
      // Lock the sources in a deterministic order. Without this, two people
      // merging overlapping selections at the same moment could split one
      // pallet's lines across two destinations — and with the ids unordered,
      // opposite-order merges deadlock instead of queueing.
      const locked = await m
        .getRepository(Pallet)
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.id IN (:...ids)', { ids })
        .orderBy('p.id', 'ASC')
        .getMany();

      if (locked.length !== ids.length) {
        throw new NotFoundException(
          'One or more of the selected pallets no longer exist.',
        );
      }

      // Re-validated INSIDE the lock: the preview the operator saw may be
      // seconds stale, and everything it checked is something another session
      // could have changed in between.
      const sources = await this.toMergeCandidates(locked, m);
      const blockers = mergeBlockers(sources);
      if (blockers.length) {
        throw new ConflictException(blockers.join(' '));
      }

      const byId = new Map(locked.map((p) => [p.id, p]));
      const ordered = ids.map((id) => byId.get(id)!);
      const agreed = <T>(pick: (p: Pallet) => T): T | null => {
        const values = new Set(ordered.map(pick));
        return values.size === 1 ? ordered.map(pick)[0] : null;
      };

      const pallets = m.getRepository(Pallet);
      const created = await this.saveUnique(
        () =>
          pallets.save(
            pallets.create({
              palletNumber,
              description:
                (dto.description ?? '').trim() ||
                `Merged from ${ordered.map((p) => p.palletNumber).join(', ')}`,
              // Inherited only where the sources agree — a merged pallet with
              // two different suppliers has no single supplier, and guessing
              // one would be a lie that then prints on the report.
              supplier: agreed((p) => p.supplier),
              // Deliberately not inherited: a freshly merged pallet has not
              // been sold to anyone.
              buyer: null,
              locationId: dto.locationId ?? agreed((p) => p.locationId),
              status: PalletStatus.OPEN,
              entryLayout: ordered[0].entryLayout,
            }),
          ),
        palletNumber,
      );

      const lines = m.getRepository(PalletLine);
      const mergeRows = m.getRepository(PalletMerge);
      for (const source of ordered) {
        const summary = sources.find((s) => s.id === source.id)!;
        // OVERWRITE source_pallet_id — never COALESCE it with the existing
        // value. It means ONE HOP: the immediate pre-merge parent. If A was
        // itself merged from X and Y, then A+B into C, C's rows must name A,
        // not X — otherwise A's own page shows nothing and C claims a parent it
        // never merged with. The full chain lives in pallet_merges.
        await lines.update(
          { palletId: source.id },
          {
            palletId: created.id,
            sourcePalletId: source.id,
            sourcePalletNumber: source.palletNumber,
          },
        );

        await mergeRows.save(
          mergeRows.create({
            resultPalletId: created.id,
            sourcePalletId: source.id,
            sourcePalletNumber: source.palletNumber,
            unitsContributed: summary.totalQuantity,
            linesContributed: summary.lineCount,
            mergedById: userId,
          }),
        );
      }

      // shippedAt deliberately untouched — merging is not shipping.
      await pallets.update({ id: In(ids) }, { status: PalletStatus.MERGED });

      return created.id;
    });

    const merged = await this.findOne(newPalletId);

    // AFTER the commit, never inside it. ActivityService.record swallows its
    // own failures, so a call inside the transaction could hide a real error —
    // and a log written before a rollback would record a merge that never
    // happened.
    const sourceRows = await this.merges.find({
      where: { resultPalletId: newPalletId },
    });
    const summary = sourceRows
      .map(
        (s) =>
          `${s.sourcePalletNumber} (${s.linesContributed} lines, ${s.unitsContributed} units)`,
      )
      .join(' and ');
    await this.activity.record({
      userId,
      action: 'pallet.merged',
      entityType: 'pallet',
      entityId: newPalletId,
      summary: `Merged ${summary} into ${merged.palletNumber} (${merged.lineCount} lines, ${merged.totalQuantity} units)`,
    });
    // One row per source too: someone opening a pallet that has gone quiet must
    // be able to see why, and activity is queried by entityId.
    for (const s of sourceRows) {
      await this.activity.record({
        userId,
        action: 'pallet.merged_into',
        entityType: 'pallet',
        entityId: s.sourcePalletId,
        summary: `${s.sourcePalletNumber} merged into ${merged.palletNumber} — ${s.unitsContributed} units moved`,
      });
    }

    return merged;
  }

  // Line counts for a set of pallets, optionally inside a transaction.
  private async toMergeCandidates(
    pallets: Pallet[],
    manager?: EntityManager,
  ): Promise<MergeCandidate[]> {
    if (pallets.length === 0) return [];
    const repo = manager ? manager.getRepository(PalletLine) : this.lines;
    const rows = await repo
      .createQueryBuilder('line')
      .select('line.palletId', 'palletId')
      .addSelect('COALESCE(SUM(line.quantity), 0)', 'total')
      .addSelect('COUNT(*)', 'lines')
      .where('line.palletId IN (:...ids)', { ids: pallets.map((p) => p.id) })
      .groupBy('line.palletId')
      .getRawMany<{ palletId: string; total: string; lines: string }>();
    const map = new Map(rows.map((r) => [r.palletId, r]));

    return pallets.map((p) => ({
      id: p.id,
      palletNumber: p.palletNumber,
      status: p.status,
      entryLayout: p.entryLayout,
      totalQuantity: parseInt(map.get(p.id)?.total ?? '0', 10),
      lineCount: parseInt(map.get(p.id)?.lines ?? '0', 10),
    }));
  }

  async remove(id: string): Promise<void> {
    const doomed = await this.assertPallet(id);
    // Never let a pallet delete take devices with it. The FK is SET NULL as a
    // backstop, but silently dumping units back into their lot pools is a
    // stock movement nobody asked for — refuse until they are moved off.
    const deviceCount = await this.assets.count({ where: { palletId: id } });
    if (deviceCount > 0) {
      throw new ConflictException(
        `${doomed.palletNumber} still holds ${deviceCount} device${
          deviceCount === 1 ? '' : 's'
        } — remove them from the pallet first.`,
      );
    }
    await this.pallets.delete(id); // cascades pallet_lines
  }

  // --- asset allocation (Goods In -> Move to Pallet) ---

  // Whole-pallet sale for serialized devices. Pricing mirrors the line-pallet
  // precedent exactly — an optional lump total, split across the units (equal
  // shares here, since every device is quantity one), remainder on the last so
  // the stored sum equals what was entered. The money lands as per-device
  // salePrice ONLY: no pallet_sold_lines row is written, because revenue
  // reporting reads both archives and writing both would double-count.
  //
  // The pallet ships WITH its devices: their pallet link is KEPT, so the
  // shipped pallet remains the manifest of exactly what left — unlike an
  // individual sale off a live pallet, which clears the link because that
  // device left alone.
  // Returns sellPallet's shape: soldUnits = devices, soldLines = 0 (there are
  // no quantity lines to count), so the one caller reads one contract.
  private async sellAssetPallet(
    pallet: Pallet,
    userId: string,
    saleTotal?: number,
  ): Promise<{ soldLines: number; soldUnits: number }> {
    const devices = await this.assets.find({
      where: { palletId: pallet.id },
    });
    const unsold = devices.filter((d) => d.stockStatus !== AssetStockStatus.SOLD);
    if (unsold.length === 0) {
      throw new ConflictException('This pallet has nothing left to sell.');
    }

    const shares = splitSaleTotal(saleTotal, unsold.length);
    const soldAt = new Date();
    for (let i = 0; i < unsold.length; i++) {
      const d = unsold[i];
      await this.assets.update(d.id, {
        stockStatus: AssetStockStatus.SOLD,
        soldAt,
        soldById: userId,
        salePrice: shares[i],
      });
      await this.assetHistory.save(
        this.assetHistory.create({
          assetId: d.id,
          eventType: AssetEventType.STATUS_CHANGED,
          userId,
          notes: `${d.stockStatus} -> sold (sold with ${pallet.palletNumber})`,
        }),
      );
    }
    await this.pallets.update(pallet.id, {
      status: PalletStatus.SHIPPED,
      shippedAt: soldAt,
    });
    await this.activity.record({
      userId,
      action: 'pallet.sold',
      entityType: 'pallet',
      entityId: pallet.id,
      summary: `Sold ${pallet.palletNumber} — ${unsold.length} device${
        unsold.length === 1 ? '' : 's'
      }${saleTotal != null ? ` for £${saleTotal}` : ''}`,
    });
    return { soldLines: 0, soldUnits: unsold.length };
  }

  // Batch-level transfer (client spec: Goods In -> Transfer Entire Batch):
  // create a NEW auto-numbered asset pallet and move every ELIGIBLE serialized
  // device from the lot onto it in one action. Eligible = not sold, not
  // already on a pallet — the same rules the per-item move applies, applied
  // to the whole pool at once so nobody ticks 22 boxes. Items MOVE, never
  // copy: the batch link survives as origin, the pallet becomes the current
  // location, and the lot's live counts drop to zero — total stock unchanged.
  async transferBatch(
    batchId: string,
    user: RequestUser,
  ): Promise<{
    palletId: string;
    palletNumber: string;
    moved: number;
    skipped: { id: string; reason: string }[];
  }> {
    const batch = await this.batches.findOne({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(`Lot ${batchId} not found`);
    if (isScopedManager(user) && !(await managerCanAccessBatch(this.batches, batchId, user))) {
      throw new ForbiddenException('You do not have access to this lot.');
    }

    const eligible = await this.assets.find({
      where: { batchId, palletId: IsNull() },
      select: { id: true, stockStatus: true },
    });
    const ids = eligible
      .filter((a) => a.stockStatus !== ('sold' as Asset['stockStatus']))
      .map((a) => a.id);
    if (ids.length === 0) {
      throw new ConflictException(
        `${batch.batchNumber} has no devices eligible for transfer — they are all sold or already on pallets.`,
      );
    }

    // The pallet is created FIRST, then filled through the exact same per-item
    // path the manual selection uses — one set of rules, not two.
    const pallet = await this.create({ entryLayout: PalletEntryLayout.ASSET });
    const result = await this.addAssets(pallet.id, ids, user);

    await this.activity.record({
      userId: user.userId,
      action: 'pallet.batch_transferred',
      entityType: 'pallet',
      entityId: pallet.id,
      summary: `Transferred ${result.moved} device${result.moved === 1 ? '' : 's'} from ${batch.batchNumber} to ${pallet.palletNumber}`,
    });

    return {
      palletId: pallet.id,
      palletNumber: pallet.palletNumber,
      moved: result.moved,
      skipped: result.skipped,
    };
  }

  // Move devices onto an asset pallet. Loops per item and reports skips like
  // bulkReturnFromSold: a warehouse selection is heterogeneous, and one sold
  // unit must not abort the other eleven.
  async addAssets(
    palletId: string,
    assetIds: string[],
    user: RequestUser,
  ): Promise<{ moved: number; skipped: { id: string; reason: string }[] }> {
    const pallet = await this.assertPallet(palletId);
    if (pallet.entryLayout !== PalletEntryLayout.ASSET) {
      throw new ConflictException(
        `${pallet.palletNumber} is a quantity pallet — devices can only be moved onto an asset pallet.`,
      );
    }
    if (pallet.status === PalletStatus.SHIPPED) {
      throw new ConflictException(
        `${pallet.palletNumber} has shipped — those goods have left the warehouse.`,
      );
    }

    const wanted = [...new Set(assetIds)].filter((id) => UUID_RE.test(id));
    if (wanted.length === 0) {
      throw new BadRequestException('Select at least one device to move.');
    }
    const found = await this.assets.find({ where: { id: In(wanted) } });
    const byId = new Map(found.map((a) => [a.id, a]));

    // Scoped managers may only move devices out of lots they own (or pool
    // lots) — same ownership axis as every other list, checked per lot once.
    const ownable = new Map<string, boolean>();
    const mayTouch = async (a: Asset): Promise<boolean> => {
      if (!isScopedManager(user)) return true;
      if (a.batchId == null) return false;
      if (!ownable.has(a.batchId)) {
        ownable.set(a.batchId, await managerCanAccessBatch(this.batches, a.batchId, user));
      }
      return ownable.get(a.batchId)!;
    };

    let moved = 0;
    const skipped: { id: string; reason: string }[] = [];
    for (const id of wanted) {
      const a = byId.get(id);
      if (!a) {
        skipped.push({ id, reason: 'not found' });
        continue;
      }
      if (a.stockStatus === ('sold' as Asset['stockStatus'])) {
        skipped.push({ id, reason: `${a.tag} is sold` });
        continue;
      }
      if (a.palletId === palletId) {
        skipped.push({ id, reason: `${a.tag} is already on this pallet` });
        continue;
      }
      if (a.palletId != null) {
        skipped.push({ id, reason: `${a.tag} is already on another pallet — remove it first` });
        continue;
      }
      if (!(await mayTouch(a))) {
        skipped.push({ id, reason: `${a.tag} is in a lot you don't own` });
        continue;
      }
      await this.assets.update(id, {
        palletId,
        movedToPalletAt: new Date(),
        movedToPalletById: user.userId,
      });
      await this.assetHistory.save(
        this.assetHistory.create({
          assetId: id,
          eventType: AssetEventType.ALLOCATED,
          userId: user.userId,
          notes: `Moved to ${pallet.palletNumber}`,
        }),
      );
      moved += 1;
    }

    if (moved > 0) {
      await this.activity.record({
        userId: user.userId,
        action: 'pallet.assets_added',
        entityType: 'pallet',
        entityId: palletId,
        summary: `Moved ${moved} device${moved === 1 ? '' : 's'} to ${pallet.palletNumber}`,
      });
    }
    return { moved, skipped };
  }

  // The reverse: back into the lot pool. Same permission as the move — a
  // mis-scan is routine warehouse reality, not a money action — and the full
  // trail is logged either way. Allocation is the pallet_id trio and nothing
  // else, so removal is exactly clearing it.
  async removeAssets(
    assetIds: string[],
    user: RequestUser,
    reason?: string,
  ): Promise<{ removed: number; skipped: { id: string; reason: string }[] }> {
    const why = (reason ?? '').trim().slice(0, 300);
    const wanted = [...new Set(assetIds)].filter((id) => UUID_RE.test(id));
    if (wanted.length === 0) {
      throw new BadRequestException('Select at least one device to remove.');
    }
    const found = await this.assets.find({
      where: { id: In(wanted) },
      relations: { pallet: true },
    });
    const byId = new Map(found.map((a) => [a.id, a]));

    const ownable = new Map<string, boolean>();
    let removed = 0;
    const skipped: { id: string; reason: string }[] = [];
    for (const id of wanted) {
      const a = byId.get(id);
      if (!a) {
        skipped.push({ id, reason: 'not found' });
        continue;
      }
      if (a.palletId == null) {
        skipped.push({ id, reason: `${a.tag} is not on a pallet` });
        continue;
      }
      if (a.stockStatus === AssetStockStatus.SOLD) {
        // Sold-with-the-pallet: the link IS the shipped manifest. Undoing a
        // sale goes through the Sold page's admin return, which also clears
        // the allocation.
        skipped.push({ id, reason: `${a.tag} is sold — return it from the Sold page first` });
        continue;
      }
      if (isScopedManager(user)) {
        const key = a.batchId ?? '';
        if (!ownable.has(key)) {
          ownable.set(
            key,
            a.batchId != null && (await managerCanAccessBatch(this.batches, a.batchId, user)),
          );
        }
        if (!ownable.get(key)) {
          skipped.push({ id, reason: `${a.tag} is in a lot you don't own` });
          continue;
        }
      }
      const palletNumber = a.pallet?.palletNumber ?? 'its pallet';
      await this.assets.update(id, {
        palletId: null,
        movedToPalletAt: null,
        movedToPalletById: null,
      });
      await this.assetHistory.save(
        this.assetHistory.create({
          assetId: id,
          eventType: AssetEventType.ALLOCATED,
          userId: user.userId,
          notes:
            `Removed from ${palletNumber} — back in its lot's pool` +
            (why ? ` — reason: ${why}` : ''),
        }),
      );
      removed += 1;
    }

    if (removed > 0) {
      await this.activity.record({
        userId: user.userId,
        action: 'pallet.assets_removed',
        entityType: 'asset',
        entityId: wanted[0],
        summary: `Removed ${removed} device${removed === 1 ? '' : 's'} from pallets`,
      });
    }
    return { removed, skipped };
  }

  // --- lines ---

  async addLine(
    palletId: string,
    dto: CreatePalletLineDto,
  ): Promise<PalletLine> {
    const lineTarget = await this.assertPallet(palletId);
    // One or the other, never both: a quantity line on an asset pallet would
    // double-count its stock the moment anything summed pallet_lines.
    if (lineTarget.entryLayout === PalletEntryLayout.ASSET) {
      throw new ConflictException(
        `${lineTarget.palletNumber} holds serialized devices — it cannot take quantity lines.`,
      );
    }
    await this.persistLineLookups(dto);
    // `variant` is NOT NULL and is what the report, the sold snapshot and
    // sold-return matching read, so it is always composed — never left to the
    // client, which no longer sends it.
    const variant = (dto.variant ?? '').trim() || composeLineVariant(dto);
    return this.lines.save(this.lines.create({ ...dto, variant, palletId }));
  }

  async updateLine(
    palletId: string,
    lineId: string,
    dto: UpdatePalletLineDto,
  ): Promise<PalletLine> {
    const line = await this.lines.findOne({ where: { id: lineId, palletId } });
    if (!line)
      throw new NotFoundException(
        `Line ${lineId} not found on pallet ${palletId}`,
      );
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
    if (!line)
      throw new NotFoundException(
        `Line ${lineId} not found on pallet ${palletId}`,
      );
    await this.lines.delete(lineId);
  }

  // Totals are always summed live from the lines, never stored, so they can't
  // drift from the counts.
  // The device rows for one or many asset pallets, projected for the page and
  // both exports from ONE code path. hardware_profile is select:false (kept
  // out of list views) — added back here because these surfaces ARE the spec
  // sheet for the devices.
  private async assetRowsByPallet(
    palletIds: string[],
  ): Promise<Map<string, PalletAssetRow[]>> {
    const out = new Map<string, PalletAssetRow[]>();
    if (palletIds.length === 0) return out;
    const devices = await this.assets
      .createQueryBuilder('asset')
      .leftJoinAndSelect('asset.movedToPalletBy', 'movedToPalletBy')
      .addSelect('asset.hardwareProfile')
      .where('asset.palletId IN (:...ids)', { ids: palletIds })
      .orderBy('asset.movedToPalletAt', 'ASC')
      .getMany();
    for (const a of devices) {
      const hp = a.hardwareProfile;
      const row: PalletAssetRow = {
        id: a.id,
        unitId: a.unitId,
        tag: a.tag,
        name: a.name,
        manufacturer: a.manufacturer ?? hp?.identification?.manufacturer ?? null,
        model: a.model ?? hp?.identification?.model ?? null,
        deviceType: a.deviceType ?? a.category ?? null,
        serialNumber: a.serialNumber,
        cpu: hp?.cpu?.model ?? null,
        ramGb: hp?.memory?.totalGb ?? null,
        storage: composeStorage(hp),
        screenSize: hp?.display?.size ?? null,
        batteryHealth: hp?.battery?.health ?? null,
        conditionGrade: a.conditionGrade,
        auditStatus: a.auditStatus,
        movedToPalletAt: a.movedToPalletAt,
        movedToPalletByName: a.movedToPalletBy
          ? sanitizeUser(a.movedToPalletBy).name
          : null,
        soldAt: a.soldAt,
        salePrice: a.salePrice,
      };
      const bucket = out.get(a.palletId!);
      if (bucket) bucket.push(row);
      else out.set(a.palletId!, [row]);
    }
    return out;
  }

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

    // Asset pallets have no lines — their total is a COUNT of the devices
    // pointing at them. Same shape out, so every list/export/merge consumer
    // sees a real number instead of a silent zero.
    const assetPalletIds = pallets
      .filter((p) => p.entryLayout === PalletEntryLayout.ASSET)
      .map((p) => p.id);
    const assetCounts = new Map<string, number>();
    if (assetPalletIds.length > 0) {
      const counts = await this.assets
        .createQueryBuilder('asset')
        .select('asset.palletId', 'palletId')
        .addSelect('COUNT(*)', 'total')
        .where('asset.palletId IN (:...ids)', { ids: assetPalletIds })
        .groupBy('asset.palletId')
        .getRawMany<{ palletId: string; total: string }>();
      for (const c of counts) assetCounts.set(c.palletId, parseInt(c.total, 10));
    }

    return pallets.map((p) => ({
      ...p,
      totalQuantity:
        p.entryLayout === PalletEntryLayout.ASSET
          ? (assetCounts.get(p.id) ?? 0)
          : parseInt(map.get(p.id)?.total ?? '0', 10),
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
    if (model)
      await this.lookupsService.findOrCreate(
        'model',
        model,
        manLookup?.id ?? null,
      );
    const size = (dto.size ?? '').trim();
    if (size) await this.lookupsService.findOrCreate('size', size);
  }

  // A duplicate pallet number is a user error, not a server fault. Postgres
  // raises 23505 on the unique constraint; without this it surfaced as an
  // opaque 500 with nothing to act on.
  private async saveUnique<T>(
    save: () => Promise<T>,
    palletNumber: string,
  ): Promise<T> {
    try {
      return await save();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        throw new ConflictException(
          `Pallet number "${palletNumber}" is already in use.`,
        );
      }
      throw err;
    }
  }

  // Public so the New Pallet form can prefill the next number as a suggestion.
  async nextPalletNumber(): Promise<string> {
    const result = await this.pallets.query(
      `SELECT nextval('pallet_number_seq') AS n`,
    );
    const n = String(result[0].n).padStart(6, '0');
    return `PALLET-${n}`;
  }

  // Every caller of this mutates the pallet it returns — adding or selling
  // lines, replacing a spec grid, returning stock onto it, deleting it. So the
  // merged check belongs here rather than repeated at six call sites: a merged
  // pallet has had its stock moved away and must be frozen, or the invariant
  // that one physical unit is one line row gets broken from the side.
  private async assertPallet(id: string): Promise<Pallet> {
    const pallet = await this.pallets.findOne({ where: { id } });
    if (!pallet) throw new NotFoundException(`Pallet ${id} not found`);
    await this.assertNotMerged(pallet);
    return pallet;
  }

  // Names where the stock actually went, because "this pallet was merged" is
  // only half an answer — the operator needs to know where to go instead. The
  // lookup only runs on the error path.
  private async assertNotMerged(pallet: Pallet): Promise<void> {
    if (pallet.status !== PalletStatus.MERGED) return;
    const merge = await this.merges.findOne({
      where: { sourcePalletId: pallet.id },
      relations: ['resultPallet'],
    });
    const into = merge?.resultPallet?.palletNumber;
    throw new ConflictException(
      into
        ? `${pallet.palletNumber} was merged into ${into} — make the change there instead.`
        : `${pallet.palletNumber} was merged into another pallet and can no longer be changed.`,
    );
  }
}

// Excel reads a Date cell as UTC, so what goes in is the London CALENDAR date
// the timestamp falls on — otherwise a pallet booked in at 00:30 BST exports as
// the previous day and disagrees with the Pallets page that listed it. Time of
// day is dropped deliberately: the column is a date, and a date sorts.
function londonDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const [day, month, year] = d
    .toLocaleDateString('en-GB', { timeZone: 'Europe/London' })
    .split('/')
    .map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

// Empty/whitespace -> null, so blank spec cells are stored (and matched) as NULL.
function nz(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

// --- merge validation -----------------------------------------------------

export interface MergeCandidate {
  id: string;
  palletNumber: string;
  status: string;
  entryLayout: string | null;
  totalQuantity: number;
  lineCount: number;
}

export function layoutName(entryLayout: string | null | undefined): string {
  if (entryLayout === PalletEntryLayout.ASSET) return 'Serialized';
  return entryLayout === PalletEntryLayout.SPEC ? 'Layout 2' : 'Layout 1';
}

// Everything that makes a merge impossible, phrased as sentences an operator
// can act on. Pure and exported so the workspace can answer "why is Merge
// disabled?" without opening a transaction, and so it is testable without a
// database — the merge itself re-runs it under a row lock, which is the check
// that actually counts.
export function mergeBlockers(sources: MergeCandidate[]): string[] {
  const blockers: string[] = [];

  // Exactly two, per spec — not "two or more". A merge has no undo, and the
  // confirmation names both pallets and the combined total; keeping it to a
  // pair is what makes that sentence checkable before someone commits to it.
  if (sources.length < 2) {
    return ['Merge requires exactly 2 pallets.'];
  }
  if (sources.length > 2) {
    return ['Please select exactly 2 pallets to merge.'];
  }
  if (new Set(sources.map((s) => s.id)).size !== sources.length) {
    blockers.push('The same pallet was selected more than once.');
  }

  for (const s of sources) {
    if (s.entryLayout === PalletEntryLayout.ASSET) {
      // v1 boundary, stated rather than fudged: merging device-holding pallets
      // means a second move path for asset rows plus asset-aware provenance,
      // which nothing needs yet. The blocker keeps the merge invariant safe.
      blockers.push(
        `${s.palletNumber} holds serialized devices — merging asset pallets isn't supported yet.`,
      );
      continue;
    }
    if (s.status === PalletStatus.SHIPPED) {
      blockers.push(
        `${s.palletNumber} has shipped — those goods have left the warehouse.`,
      );
    } else if (s.status === PalletStatus.MERGED) {
      blockers.push(
        `${s.palletNumber} was already merged into another pallet.`,
      );
    } else if (s.lineCount === 0 || s.totalQuantity <= 0) {
      blockers.push(
        `${s.palletNumber} is empty — there is nothing to move off it.`,
      );
    }
  }

  // Refusing a cross-layout merge is not fussiness. The two layouts store their
  // data in different places — Layout 1 on the line's own columns, Layout 2 on
  // the linked catalogue product — so a mixed pallet exports unreadable rows
  // whichever layout it claims. Worse, marking it Layout 2 arms a data-loss
  // trap: the spec editor saves by deleting every line and recreating from the
  // grid, so the operator's first routine edit would destroy every unit cost,
  // grade and scrap of merge provenance on the Layout 1 rows.
  const layouts = new Set(
    sources.map((s) => s.entryLayout ?? PalletEntryLayout.VARIANT),
  );
  if (layouts.size > 1) {
    const named = sources.map(
      (s) => `${s.palletNumber} is ${layoutName(s.entryLayout)}`,
    );
    blockers.push(
      `${named.join(', ')}. Pallets built with different layouts export different reports and cannot be merged.`,
    );
  }

  return blockers;
}

// --- report columns -------------------------------------------------------
//
// Each layout's columns are defined ONCE and read by every generator: the
// per-pallet report and the multi-pallet export. They were inlined per
// generator, which is how a report nobody meant to change changes — someone
// adds a column to one copy and the other two silently disagree. The title
// merge range and the total-row cells already derive from headers.length, so
// these arrays are the only thing to keep in step.
//
// pallets.service.spec.ts pins both arrays against their literals: the Layout 1
// report is an established document and must not move.

export const VARIANT_HEADERS: string[] = [
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
export const VARIANT_WIDTHS: number[] = [16, 16, 22, 10, 14, 8, 10, 12, 14, 16];

// Asset-pallet export columns. Pinned by pallets-export.spec so a change
// fails the build rather than shipping quietly — same contract as the other
// two layouts.
// Split an optional lump sale total into n equal 2dp shares, remainder on the
// last so the stored sum equals what was entered — the same arithmetic the
// line-pallet sale applies per quantity, specialised to quantity-one units.
// No total -> all-null shares (unpriced sale, same as an unpriced line sale).
export function splitSaleTotal(
  total: number | null | undefined,
  n: number,
): (number | null)[] {
  if (total == null || total < 0 || n <= 0) return Array(n).fill(null);
  const share = Math.round((total / n) * 100) / 100;
  const shares: (number | null)[] = Array(n).fill(share);
  const allocated = Math.round(share * (n - 1) * 100) / 100;
  shares[n - 1] = Math.round((total - allocated) * 100) / 100;
  return shares;
}

export const ASSET_HEADERS: string[] = [
  'Pallet number',
  'Unit ID',
  'Serial / Tag',
  'Manufacturer',
  'Model',
  'Type',
  'CPU',
  'RAM',
  'Storage',
  'Screen',
  'Battery',
  'Grade',
  'Audit status',
  'Moved to pallet',
  'Moved by',
];
export const ASSET_WIDTHS: number[] = [16, 12, 20, 16, 22, 12, 26, 9, 20, 9, 10, 12, 16, 20, 18];

export function assetReportRow(
  palletNumber: string,
  a: {
    unitId: string | null;
    tag: string;
    manufacturer: string | null;
    model: string | null;
    deviceType: string | null;
    cpu: string | null;
    ramGb: number | null;
    storage: string | null;
    screenSize: string | null;
    batteryHealth: string | null;
    conditionGrade: string | null;
    auditStatus: string | null;
    movedToPalletAt: Date | null;
    movedToPalletByName: string | null;
  },
): (string | number)[] {
  return [
    palletNumber,
    a.unitId ?? '',
    a.tag,
    a.manufacturer ?? '',
    a.model ?? '',
    a.deviceType ?? '',
    a.cpu ?? '',
    // No space before GB, matching SPEC_RAM's convention everywhere else.
    a.ramGb != null ? `${a.ramGb}GB` : '',
    a.storage ?? '',
    a.screenSize ?? '',
    a.batteryHealth ?? '',
    a.conditionGrade ?? '',
    a.auditStatus ?? '',
    a.movedToPalletAt ? new Date(a.movedToPalletAt).toLocaleString('en-GB') : '',
    a.movedToPalletByName ?? '',
  ];
}

export const SPEC_HEADERS: string[] = [
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
export const SPEC_WIDTHS: number[] = [16, 16, 22, 12, 20, 10, 10, 16, 12];

export function palletLineTotal(line: PalletLine): number | null {
  return line.unitCost != null ? line.unitCost * line.quantity : null;
}

// One Layout 1 row. The pallet number leads every row: the sheet is filtered
// and sorted downstream, and a row that loses its pallet is unusable.
export function variantRow(
  palletNumber: string,
  line: PalletLine,
): (string | number)[] {
  const total = palletLineTotal(line);
  return [
    palletNumber,
    line.manufacturer ?? '',
    line.model ?? '',
    line.size ?? '',
    slugLabel(line.variantType),
    line.stand == null ? '' : line.stand ? 'Yes' : 'No',
    line.quantity,
    gradeLabel(line.grade),
    line.unitCost != null ? line.unitCost : '',
    total != null ? total : '',
  ];
}

// One Layout 2 row. Same rule about the leading pallet number, and one row per
// LINE — quantity stays a count, so a line of 45 is still a single row.
export function specRow(
  palletNumber: string,
  line: PalletLine,
): (string | number)[] {
  const s = specColumns(line.product, line.variant);
  return [
    palletNumber,
    s.manufacturer,
    s.model,
    s.chassis,
    s.cpu,
    s.gen,
    s.ram,
    s.storage,
    line.quantity,
  ];
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
export function ramLabel(
  ramGb: number | null | undefined,
  unit = ' GB',
): string {
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
  return [
    row.manufacturer,
    row.model,
    row.chassis,
    row.cpu,
    row.gen,
    row.ram,
    row.storage,
  ]
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join(' · ');
}

// Pallet numbers are typed now, and the report filename is interpolated straight
// into an HTTP Content-Disposition header. A quote truncates that header, a
// slash or semicolon corrupts it, and a newline makes Node throw
// ERR_INVALID_CHAR — a 500 on export for a pallet that is otherwise fine.
export function safeFilePart(value: string, fallback: string): string {
  const clean = (value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

// £1,234.50 — the same shape the web shows, so a printed sheet and the screen
// never disagree about a figure.
function money(n: number): string {
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
