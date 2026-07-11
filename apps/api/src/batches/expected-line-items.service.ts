import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Batch } from './batch.entity';
import { ExpectedLineItem } from './expected-line-item.entity';
import { Asset } from '../assets/asset.entity';
import { ImportExpectedDto } from './dto/import-expected.dto';

// One expected serialized line matched (or not) against the physically
// scanned assets in the lot.
export interface ReconciledLine {
  expected: ExpectedLineItem;
  status: 'found' | 'missing';
  matchedAssetId: string | null;
  matchedTag: string | null;
}

export interface ReconciliationResult {
  summary: {
    expectedSerialized: number; // expected lines that carry a serial/tag to match on
    found: number;
    missing: number;
    extra: number; // scanned but not on the supplier list
    scanned: number; // total assets scanned into the lot
    quantityOnlyLines: number; // expected lines with no serial (bulk/qty), not serial-matched
  };
  lines: ReconciledLine[];
  extras: { id: string; tag: string; name: string }[];
  quantityOnly: ExpectedLineItem[];
}

@Injectable()
export class ExpectedLineItemsService {
  constructor(
    @InjectRepository(ExpectedLineItem)
    private expected: Repository<ExpectedLineItem>,
    @InjectRepository(Batch) private batches: Repository<Batch>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
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

  // Computed live (like the batch unit counts) so it can never go stale: diff
  // the supplier's expected list against the assets actually scanned into the
  // lot. Serialized lines are matched by their serial/asset-tag against the
  // value scanned off each device (Asset.tag). Bulk/quantity lines (no serial)
  // are reported separately rather than force-matched.
  async reconcile(batchId: string): Promise<ReconciliationResult> {
    await this.assertBatch(batchId);
    const [expected, assets] = await Promise.all([
      this.expected.find({ where: { batchId }, order: { createdAt: 'ASC' } }),
      this.assets.find({ where: { batchId } }),
    ]);

    // Match on the tag scanned off each device, case-insensitively (a serial
    // is the same whether typed "4tc81g2" or "4TC81G2"). First scan of a tag
    // wins as the representative match.
    const assetByTag = new Map<string, Asset>();
    for (const a of assets) {
      const key = a.tag.trim().toLowerCase();
      if (!assetByTag.has(key)) assetByTag.set(key, a);
    }

    const expectedIds = new Set<string>();
    const lines: ReconciledLine[] = [];
    const quantityOnly: ExpectedLineItem[] = [];

    for (const e of expected) {
      const identifier = (e.serialNumber ?? e.assetTag ?? '').trim().toLowerCase();
      if (!identifier) {
        quantityOnly.push(e);
        continue;
      }
      expectedIds.add(identifier);
      const match = assetByTag.get(identifier);
      lines.push({
        expected: e,
        status: match ? 'found' : 'missing',
        matchedAssetId: match?.id ?? null,
        matchedTag: match?.tag ?? null,
      });
    }

    // Extra = a scanned device whose tag is on NO expected line at all. A
    // duplicate scan of an expected serial is NOT extra — the line it matches
    // is already Found — so match against the expected set, not 1:1 pairing.
    const extras = assets
      .filter((a) => !expectedIds.has(a.tag.trim().toLowerCase()))
      .map((a) => ({ id: a.id, tag: a.tag, name: a.name }));

    const found = lines.filter((l) => l.status === 'found').length;

    return {
      summary: {
        expectedSerialized: lines.length,
        found,
        missing: lines.length - found,
        extra: extras.length,
        scanned: assets.length,
        quantityOnlyLines: quantityOnly.length,
      },
      lines,
      extras,
      quantityOnly,
    };
  }

  private async assertBatch(batchId: string): Promise<void> {
    const count = await this.batches.countBy({ id: batchId });
    if (count === 0) throw new NotFoundException(`Purchase lot ${batchId} not found`);
  }
}
