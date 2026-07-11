import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StockLine } from './stock-line.entity';
import { StockMovement, StockMovementReason } from './stock-movement.entity';
import { CreateStockLineDto } from './dto/create-stock-line.dto';
import { UpdateStockLineDto } from './dto/update-stock-line.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';

@Injectable()
export class StockService {
  constructor(
    @InjectRepository(StockLine) private lines: Repository<StockLine>,
    @InjectRepository(StockMovement) private movements: Repository<StockMovement>,
  ) {}

  findAll(search?: string): Promise<StockLine[]> {
    const qb = this.lines
      .createQueryBuilder('line')
      .leftJoinAndSelect('line.location', 'location')
      .orderBy('line.name', 'ASC');
    if (search) {
      qb.where('(line.name ILIKE :s OR line.sku ILIKE :s OR line.category ILIKE :s)', {
        s: `%${search}%`,
      });
    }
    return qb.getMany();
  }

  async findOne(id: string): Promise<StockLine & { movements: StockMovement[] }> {
    const line = await this.lines.findOne({ where: { id }, relations: ['location'] });
    if (!line) throw new NotFoundException(`Stock line ${id} not found`);
    const movements = await this.movements.find({
      where: { stockLineId: id },
      order: { createdAt: 'DESC' },
    });
    return { ...line, movements };
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

  async remove(id: string): Promise<void> {
    await this.assertLine(id);
    await this.lines.delete(id); // cascades movements
  }

  private async assertLine(id: string): Promise<void> {
    const count = await this.lines.countBy({ id });
    if (count === 0) throw new NotFoundException(`Stock line ${id} not found`);
  }
}
