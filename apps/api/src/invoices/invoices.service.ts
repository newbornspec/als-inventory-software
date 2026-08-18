import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Invoice, InvoiceLine } from './invoice.entity';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { calculateTotals } from './invoice-totals';
import { PalletsService } from '../pallets/pallets.service';
import { ActivityService } from '../activity/activity.service';

@Injectable()
export class InvoicesService {
  constructor(
    @InjectRepository(Invoice) private invoices: Repository<Invoice>,
    private pallets: PalletsService,
    private activity: ActivityService,
  ) {}

  async findOne(id: string): Promise<Invoice> {
    const invoice = await this.invoices.findOne({ where: { id } });
    if (!invoice) throw new NotFoundException(`Invoice ${id} not found`);
    return invoice;
  }

  async findForPallet(palletId: string): Promise<Invoice[]> {
    return this.invoices.find({ where: { palletId }, order: { createdAt: 'DESC' } });
  }

  // The number the NEXT invoice would get. Deliberately does not consume it:
  // the form shows this before anything is saved, and an abandoned form must
  // not burn a number or leave a permanent gap in the series. The real number
  // is allocated atomically at save time, so if someone else invoices first
  // this preview simply moves on.
  async peekNextNumber(when = new Date()): Promise<{ invoiceNumber: string; year: number }> {
    const year = when.getFullYear();
    const rows = await this.invoices.query(
      `SELECT "last_number" FROM "invoice_counters" WHERE "year" = $1`,
      [year],
    );
    const next = (rows[0]?.last_number ?? 0) + 1;
    return { invoiceNumber: formatInvoiceNumber(year, next), year };
  }

  // Allocate the next number for the year in ONE statement. Two people pressing
  // Generate at the same moment each get their own number: the row lock taken by
  // the UPDATE serialises them, and RETURNING hands back the value that row now
  // holds. Reading-then-incrementing in two statements is what produces
  // duplicates under concurrency.
  private async allocateNumber(year: number): Promise<number> {
    const rows = await this.invoices.query(
      `INSERT INTO "invoice_counters" ("year", "last_number") VALUES ($1, 1)
       ON CONFLICT ("year") DO UPDATE
         SET "last_number" = "invoice_counters"."last_number" + 1
       RETURNING "last_number"`,
      [year],
    );
    return Number(rows[0].last_number);
  }

  async createForPallet(
    palletId: string,
    dto: CreateInvoiceDto,
    userId: string,
  ): Promise<Invoice> {
    const pallet = await this.pallets.findOne(palletId);

    // Snapshot the lines as they are now. Selling a pallet line deletes it, so
    // an invoice that referenced them would empty itself the moment the pallet
    // sold — see the migration for the full reasoning.
    const lines: InvoiceLine[] = pallet.lines.map((l) => ({
      manufacturer: l.manufacturer,
      model: l.model,
      size: l.size,
      variantType: l.variantType,
      stand: l.stand,
      grade: l.grade,
      quantity: l.quantity,
      unitPrice: l.unitCost,
      lineTotal: null, // filled from the calculation below
    }));

    const totals = calculateTotals({
      lines: lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice })),
      vatRegistered: dto.vatRegistered,
      vatRate: dto.vatRate ?? null,
    });
    totals.lineTotals.forEach((t, i) => {
      lines[i].lineTotal = t;
    });

    const invoiceDate = (dto.invoiceDate ?? new Date().toISOString()).slice(0, 10);
    // The year comes from the invoice DATE, not from today: a back-dated
    // invoice belongs to its own year's series.
    const year = Number(invoiceDate.slice(0, 4));
    const seq = await this.allocateNumber(year);
    const invoiceNumber = formatInvoiceNumber(year, seq);

    let saved: Invoice;
    try {
      saved = await this.invoices.save(
        this.invoices.create({
          invoiceNumber,
          invoiceYear: year,
          invoiceDate,
          palletId: pallet.id,
          palletNumber: pallet.palletNumber,
          buyerName: dto.buyerName.trim(),
          buyerAddress1: nz(dto.buyerAddress1),
          buyerAddress2: nz(dto.buyerAddress2),
          buyerCity: nz(dto.buyerCity),
          buyerPostcode: nz(dto.buyerPostcode),
          buyerCountry: nz(dto.buyerCountry),
          // Not registered means the number and rate are not merely blank, they
          // are inapplicable — stored NULL so nothing downstream can read a
          // stale rate left in the form.
          vatRegistered: dto.vatRegistered,
          vatNumber: dto.vatRegistered ? nz(dto.vatNumber) : null,
          vatRate: dto.vatRegistered ? (dto.vatRate ?? null) : null,
          subtotal: totals.subtotal,
          vatAmount: totals.vatAmount,
          total: totals.total,
          lines,
          notes: nz(dto.notes),
          createdById: userId,
        }),
      );
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException(
          `Invoice number ${invoiceNumber} already exists. Try again.`,
        );
      }
      throw err;
    }

    await this.activity.record({
      userId,
      action: 'invoice.created',
      entityType: 'invoice',
      entityId: saved.id,
      summary: `Raised ${saved.invoiceNumber} for ${pallet.palletNumber} to ${saved.buyerName}`,
    });

    return saved;
  }
}

// INV-2026-0001. Four digits matches the requested format and leaves room for
// 9999 invoices a year; padStart does not truncate beyond that, it just grows.
export function formatInvoiceNumber(year: number, seq: number): string {
  return `INV-${year}-${String(seq).padStart(4, '0')}`;
}

function nz(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}
