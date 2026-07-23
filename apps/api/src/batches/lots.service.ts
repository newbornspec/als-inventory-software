import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Lot } from './lot.entity';
import { Batch } from './batch.entity';
import { CreateLotDto } from './dto/create-lot.dto';
import { UpdateLotDto } from './dto/update-lot.dto';
import { Asset } from '../assets/asset.entity';
import {
  accessibleBatchWhere,
  isScopedManager,
  managerCanAccessBatch,
  type RequestUser,
} from '../common/ownership';

export interface LotWithCount extends Lot {
  actualUnitCount: number;
}

@Injectable()
export class LotsService {
  constructor(
    @InjectRepository(Lot) private lots: Repository<Lot>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
  ) {}

  // A scoped manager may only touch sub-lots whose parent lot they own.
  private async assertOwnsParent(batchId: string | null | undefined, user?: RequestUser) {
    if (!isScopedManager(user)) return;
    if (!(await managerCanAccessBatch(this.batches, batchId, user!))) {
      throw new ForbiddenException('You do not own that lot.');
    }
  }

  async findAll(batchId?: string, user?: RequestUser): Promise<LotWithCount[]> {
    if (isScopedManager(user)) {
      const owned = (
        await this.batches.find({ where: accessibleBatchWhere(user), select: { id: true } })
      ).map((b) => b.id);
      if (batchId && !owned.includes(batchId)) return [];
      const ids = batchId ? [batchId] : owned;
      if (ids.length === 0) return [];
      const lots = await this.lots.find({
        where: { batchId: In(ids) },
        order: { createdAt: 'DESC' },
      });
      return this.withCounts(lots);
    }
    const lots = await this.lots.find({
      where: batchId ? { batchId } : {},
      order: { createdAt: 'DESC' },
    });
    return this.withCounts(lots);
  }

  async findOne(id: string, user?: RequestUser): Promise<LotWithCount> {
    const lot = await this.lots.findOne({ where: { id } });
    if (!lot) throw new NotFoundException(`Lot ${id} not found`);
    // Not-found (don't reveal) for a scoped manager who can't access the parent.
    if (isScopedManager(user) && !(await managerCanAccessBatch(this.batches, lot.batchId, user!))) {
      throw new NotFoundException(`Lot ${id} not found`);
    }
    return (await this.withCounts([lot]))[0];
  }

  async create(dto: CreateLotDto, user?: RequestUser): Promise<Lot> {
    await this.assertOwnsParent(dto.batchId, user);
    const lotNumber = await this.nextLotNumber();
    return this.lots.save(this.lots.create({ ...dto, lotNumber }));
  }

  async update(id: string, dto: UpdateLotDto, user?: RequestUser): Promise<LotWithCount> {
    await this.findOne(id, user); // 404 if a manager doesn't own the parent lot
    if (dto.batchId !== undefined) await this.assertOwnsParent(dto.batchId, user);
    await this.lots.update(id, dto);
    return this.findOne(id, user);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.lots.delete(id);
  }

  private async withCounts(lots: Lot[]): Promise<LotWithCount[]> {
    if (lots.length === 0) return [];
    const counts = await this.assets
      .createQueryBuilder('asset')
      .select('asset.lotId', 'lotId')
      .addSelect('COUNT(*)', 'count')
      .where('asset.lotId IN (:...ids)', { ids: lots.map((l) => l.id) })
      .groupBy('asset.lotId')
      .getRawMany<{ lotId: string; count: string }>();
    const countMap = new Map(counts.map((c) => [c.lotId, parseInt(c.count, 10)]));
    return lots.map((l) => ({ ...l, actualUnitCount: countMap.get(l.id) ?? 0 }));
  }

  private async nextLotNumber(): Promise<string> {
    const result = await this.lots.query(`SELECT nextval('lot_number_seq') AS n`);
    const n = String(result[0].n).padStart(6, '0');
    return `LOT-${n}`;
  }
}
