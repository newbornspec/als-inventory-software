import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Batch } from './batch.entity';
import { ExpectedLineItem } from './expected-line-item.entity';
import { ImportExpectedDto } from './dto/import-expected.dto';

@Injectable()
export class ExpectedLineItemsService {
  constructor(
    @InjectRepository(ExpectedLineItem)
    private expected: Repository<ExpectedLineItem>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
  ) {}

  async findForBatch(batchId: string): Promise<ExpectedLineItem[]> {
    await this.assertBatch(batchId);
    return this.expected.find({
      where: { batchId },
      order: { createdAt: 'ASC' },
    });
  }

  // Replace-on-import: the uploaded file IS the expected inventory, so a
  // corrected re-import cleanly supersedes the previous one rather than
  // duplicating rows. Runs in a transaction so a batch is never left half-set.
  async importForBatch(batchId: string, dto: ImportExpectedDto): Promise<ExpectedLineItem[]> {
    await this.assertBatch(batchId);
    return this.expected.manager.transaction(async (tx) => {
      const repo = tx.getRepository(ExpectedLineItem);
      await repo.delete({ batchId });
      const rows = dto.items.map((item) =>
        repo.create({
          batchId,
          assetTag: item.assetTag ?? null,
          serialNumber: item.serialNumber ?? null,
          manufacturer: item.manufacturer ?? null,
          model: item.model ?? null,
          cpu: item.cpu ?? null,
          ramGb: item.ramGb ?? null,
          storage: item.storage ?? null,
          screenSize: item.screenSize ?? null,
          condition: item.condition ?? null,
          grade: item.grade ?? null,
          quantity: item.quantity ?? 1,
        }),
      );
      if (rows.length === 0) return [];
      // chunked insert keeps a huge manifest from blowing the parameter limit
      await repo.save(rows, { chunk: 500 });
      return repo.find({ where: { batchId }, order: { createdAt: 'ASC' } });
    });
  }

  async clearForBatch(batchId: string): Promise<void> {
    await this.assertBatch(batchId);
    await this.expected.delete({ batchId });
  }

  private async assertBatch(batchId: string): Promise<void> {
    const count = await this.batches.countBy({ id: batchId });
    if (count === 0) throw new NotFoundException(`Purchase lot ${batchId} not found`);
  }
}
