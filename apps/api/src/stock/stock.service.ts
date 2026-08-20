import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { StockLine } from './stock-line.entity';
import { StockMovement, StockMovementReason } from './stock-movement.entity';
import { CreateStockLineDto } from './dto/create-stock-line.dto';
import { UpdateStockLineDto } from './dto/update-stock-line.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { TransferStockDto } from './dto/transfer-stock.dto';
import { Location } from '../locations/location.entity';

// Consumable stock status is DERIVED from on-hand quantity (never stored, so it
// can't drift): 0 → out of stock, below the threshold → low, otherwise in stock.
export const LOW_STOCK_THRESHOLD = 10;
export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';
export function stockStatusFor(quantity: number): StockStatus {
  if (quantity <= 0) return 'out_of_stock';
  if (quantity < LOW_STOCK_THRESHOLD) return 'low_stock';
  return 'in_stock';
}
export type StockLineWithStatus = StockLine & { status: StockStatus };

@Injectable()
export class StockService {
  constructor(
    @InjectRepository(StockLine) private lines: Repository<StockLine>,
    @InjectRepository(StockMovement) private movements: Repository<StockMovement>,
  ) {}

  async findAll(search?: string): Promise<StockLineWithStatus[]> {
    const qb = this.lines
      .createQueryBuilder('line')
      .leftJoinAndSelect('line.location', 'location')
      .orderBy('line.name', 'ASC');
    if (search) {
      qb.where('(line.name ILIKE :s OR line.sku ILIKE :s OR line.category ILIKE :s)', {
        s: `%${search}%`,
      });
    }
    const rows = await qb.getMany();
    return rows.map((r) => ({ ...r, status: stockStatusFor(r.quantity) }));
  }

  async findOne(
    id: string,
  ): Promise<StockLineWithStatus & { movements: StockMovement[] }> {
    const line = await this.lines.findOne({ where: { id }, relations: ['location'] });
    if (!line) throw new NotFoundException(`Stock line ${id} not found`);
    const movements = await this.movements.find({
      where: { stockLineId: id },
      order: { createdAt: 'DESC' },
    });
    return { ...line, status: stockStatusFor(line.quantity), movements };
  }

  // Create the line and, if it opens with stock, record that as the first
  // movement so the log reconciles with the quantity from day one.
  async create(dto: CreateStockLineDto, userId: string): Promise<StockLine> {
    const opening = dto.quantity ?? 0;
    return this.lines.manager.transaction(async (tx) => {
      const line = await tx.getRepository(StockLine).save(
        tx.getRepository(StockLine).create({
          name: dto.name,
          sku: dto.sku ?? null,
          category: dto.category ?? null,
          productId: dto.productId ?? null,
          locationId: dto.locationId ?? null,
          quantity: opening,
          notes: dto.notes ?? null,
        }),
      );
      if (opening > 0) {
        await tx.getRepository(StockMovement).save(
          tx.getRepository(StockMovement).create({
            stockLineId: line.id,
            delta: opening,
            reason: StockMovementReason.RECEIVED,
            note: 'Opening stock',
            userId,
          }),
        );
      }
      return line;
    });
  }

  async update(id: string, dto: UpdateStockLineDto): Promise<StockLine> {
    await this.assertLine(id);
    await this.lines.update(id, dto);
    return this.lines.findOneOrFail({ where: { id }, relations: ['location'] });
  }

  // The one path that changes quantity: apply a signed delta, log it, and keep
  // the two consistent in a transaction. Rejects moves that would go negative.
  async adjust(id: string, dto: AdjustStockDto, userId: string): Promise<StockLine> {
    if (dto.delta === 0) throw new BadRequestException('Adjustment cannot be zero.');
    return this.lines.manager.transaction(async (tx) => {
      const repo = tx.getRepository(StockLine);
      const line = await repo.findOne({ where: { id } });
      if (!line) throw new NotFoundException(`Stock line ${id} not found`);
      const next = line.quantity + dto.delta;
      if (next < 0) {
        throw new BadRequestException(
          `Only ${line.quantity} in stock — cannot remove ${Math.abs(dto.delta)}.`,
        );
      }
      line.quantity = next;
      await repo.save(line);
      await tx.getRepository(StockMovement).save(
        tx.getRepository(StockMovement).create({
          stockLineId: id,
          delta: dto.delta,
          reason: dto.reason,
          note: dto.note ?? null,
          userId,
        }),
      );
      return line;
    });
  }

  // Move stock between locations. A StockLine is (item, location), so a move is
  // not one row changing its location — that would take the whole line and its
  // entire movement history with it, including the part that happened at the
  // old place. It is a quantity leaving one line and arriving at another.
  //
  // The destination line is created if the item has never been held there. It
  // copies the identity fields (name/sku/category/product) so the two lines are
  // recognisably the same item, and opens at zero so the +n movement below is
  // its whole history rather than an unexplained opening balance.
  //
  // One transaction: a half-applied transfer would invent or destroy stock.
  async transfer(id: string, dto: TransferStockDto, userId: string): Promise<StockLine> {
    return this.lines.manager.transaction(async (tx) => {
      const repo = tx.getRepository(StockLine);
      const source = await repo.findOne({ where: { id }, relations: ['location'] });
      if (!source) throw new NotFoundException(`Stock line ${id} not found`);

      if (source.locationId === dto.toLocationId) {
        throw new BadRequestException('That is already where this stock is.');
      }
      if (source.quantity < dto.quantity) {
        throw new BadRequestException(
          `Only ${source.quantity} in stock — cannot move ${dto.quantity}.`,
        );
      }

      const to = await tx.getRepository(Location).findOne({ where: { id: dto.toLocationId } });
      if (!to) throw new NotFoundException('Destination location not found.');

      // Match on the item's identity, not its name alone: two lines can share a
      // name and differ by SKU.
      let dest = await repo.findOne({
        where: {
          locationId: dto.toLocationId,
          name: source.name,
          // A null SKU is a real value here — plenty of consumables have none —
          // and TypeORM will not match null through a plain where clause.
          sku: source.sku === null ? IsNull() : source.sku,
        },
      });
      if (!dest) {
        dest = await repo.save(
          repo.create({
            name: source.name,
            sku: source.sku,
            category: source.category,
            productId: source.productId,
            locationId: dto.toLocationId,
            quantity: 0,
            // Deliberately NOT copied: notes are commentary about this line at
            // this site ("shelf 3, reorder from Acme"), which would be a false
            // statement about the destination.
            notes: null,
          }),
        );
      }

      source.quantity -= dto.quantity;
      dest.quantity += dto.quantity;
      await repo.save(source);
      await repo.save(dest);

      // One id shared by both halves, so the pair is retrievable as the single
      // event it is. The location ids are recorded structurally; the note stays
      // free text for whatever the operator wants to say about the move.
      const transferId = randomUUID();
      const movements = tx.getRepository(StockMovement);
      const shared = {
        reason: StockMovementReason.TRANSFERRED,
        note: dto.note ?? null,
        userId,
        transferId,
        fromLocationId: source.locationId,
        toLocationId: dto.toLocationId,
      };
      await movements.save([
        movements.create({ ...shared, stockLineId: source.id, delta: -dto.quantity }),
        movements.create({ ...shared, stockLineId: dest.id, delta: dto.quantity }),
      ]);

      return source;
    });
  }

  async remove(id: string): Promise<void> {
    await this.assertLine(id);
    await this.lines.delete(id); // cascades movements
  }

  private async assertLine(id: string): Promise<void> {
    const count = await this.lines.countBy({ id });
    if (count === 0) throw new NotFoundException(`Stock line ${id} not found`);
  }
}
