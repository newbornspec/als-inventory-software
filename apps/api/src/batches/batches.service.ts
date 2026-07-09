import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Batch } from './batch.entity';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { Asset } from '../assets/asset.entity';
import { sanitizeUser, type SafeUser } from '../users/sanitize-user';

export interface BatchWithCount extends Omit<Batch, 'receivedBy'> {
  receivedBy: SafeUser | null;
  actualUnitCount: number;
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
    const counts = await this.assets
      .createQueryBuilder('asset')
      .select('asset.batchId', 'batchId')
      .addSelect('COUNT(*)', 'count')
      .where('asset.batchId IN (:...ids)', { ids: batches.map((b) => b.id) })
      .groupBy('asset.batchId')
      .getRawMany<{ batchId: string; count: string }>();
    const countMap = new Map(counts.map((c) => [c.batchId, parseInt(c.count, 10)]));
    return batches.map((b) => ({
      ...b,
      receivedBy: b.receivedBy ? sanitizeUser(b.receivedBy) : null,
      actualUnitCount: countMap.get(b.id) ?? 0,
    }));
  }

  private async nextBatchNumber(): Promise<string> {
    const result = await this.batches.query(`SELECT nextval('batch_number_seq') AS n`);
    const n = String(result[0].n).padStart(6, '0');
    return `BATCH-${n}`;
  }
}
