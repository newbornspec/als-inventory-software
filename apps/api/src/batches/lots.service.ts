import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lot } from './lot.entity';
import { CreateLotDto } from './dto/create-lot.dto';
import { UpdateLotDto } from './dto/update-lot.dto';
import { Asset } from '../assets/asset.entity';

export interface LotWithCount extends Lot {
  actualUnitCount: number;
}

@Injectable()
export class LotsService {
  constructor(
    @InjectRepository(Lot) private lots: Repository<Lot>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
  ) {}

  async findAll(batchId?: string): Promise<LotWithCount[]> {
    const lots = await this.lots.find({
      where: batchId ? { batchId } : {},
      order: { createdAt: 'DESC' },
    });
    return this.withCounts(lots);
  }

  async findOne(id: string): Promise<LotWithCount> {
    const lot = await this.lots.findOne({ where: { id } });
    if (!lot) throw new NotFoundException(`Lot ${id} not found`);
    return (await this.withCounts([lot]))[0];
  }

  async create(dto: CreateLotDto): Promise<Lot> {
    const lotNumber = await this.nextLotNumber();
    return this.lots.save(this.lots.create({ ...dto, lotNumber }));
  }

  async update(id: string, dto: UpdateLotDto): Promise<LotWithCount> {
    await this.findOne(id);
    await this.lots.update(id, dto);
    return this.findOne(id);
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
