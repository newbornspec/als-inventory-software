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
  // LIVE — sold devices excluded, exactly like Batch.actualUnitCount
  // (batches.service.ts:479) and like every list the register serves
  // (assets.service.ts:137-139). This is the figure a sub-lot is DISPLAYED
  // with, so its number always matches the rows you can actually see in it.
  actualUnitCount: number;
  // Sold-inclusive, for the same reason the parent batch carries one: a
  // destructive action has to be measured against everything the bucket holds,
  // not just what is still sellable.
  totalUnitCount: number;
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

  // This used to be a bare COUNT(*), which made a sub-lot the only count in the
  // app that included sold devices. Everything it was compared against excludes
  // them -- the parent's actualUnitCount, and the /assets lists that fill both
  // the sub-lot table and the lot table -- so the arithmetic mixed two different
  // populations: a lot that had sold a tranche out of its buckets reported
  // "20 of 12 grouped", and its per-sub-lot bars sat at 100% on devices that had
  // already left. Same split as the parent now: LIVE for what is displayed,
  // everything for what a destructive action is measured against.
  private async withCounts(lots: Lot[]): Promise<LotWithCount[]> {
    if (lots.length === 0) return [];
    const LIVE = `asset.stock_status != 'sold'`;
    const counts = await this.assets
      .createQueryBuilder('asset')
      .select('asset.lotId', 'lotId')
      .addSelect(`COUNT(*) FILTER (WHERE ${LIVE})`, 'live')
      .addSelect('COUNT(*)', 'everything')
      .where('asset.lotId IN (:...ids)', { ids: lots.map((l) => l.id) })
      .groupBy('asset.lotId')
      .getRawMany<{ lotId: string; live: string; everything: string }>();
    const countMap = new Map(counts.map((c) => [c.lotId, c]));
    return lots.map((l) => {
      const r = countMap.get(l.id);
      return {
        ...l,
        actualUnitCount: r ? parseInt(r.live, 10) : 0,
        totalUnitCount: r ? parseInt(r.everything, 10) : 0,
      };
    });
  }

  private async nextLotNumber(): Promise<string> {
    const result = await this.lots.query(`SELECT nextval('lot_number_seq') AS n`);
    const n = String(result[0].n).padStart(6, '0');
    return `LOT-${n}`;
  }
}
