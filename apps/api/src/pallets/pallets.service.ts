import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Pallet } from './pallet.entity';
import { PalletLine } from './pallet-line.entity';
import { CreatePalletDto } from './dto/create-pallet.dto';
import { UpdatePalletDto } from './dto/update-pallet.dto';
import { CreatePalletLineDto } from './dto/create-pallet-line.dto';
import { UpdatePalletLineDto } from './dto/update-pallet-line.dto';

export interface PalletWithTotals extends Pallet {
  totalQuantity: number;
  lineCount: number;
}

@Injectable()
export class PalletsService {
  constructor(
    @InjectRepository(Pallet) private pallets: Repository<Pallet>,
    @InjectRepository(PalletLine) private lines: Repository<PalletLine>,
  ) {}

  async findAll(): Promise<PalletWithTotals[]> {
    const pallets = await this.pallets.find({
      relations: ['location'],
      order: { createdAt: 'DESC' },
    });
    return this.withTotals(pallets);
  }

  async findOne(id: string): Promise<PalletWithTotals & { lines: PalletLine[] }> {
    const pallet = await this.pallets.findOne({ where: { id }, relations: ['location'] });
    if (!pallet) throw new NotFoundException(`Pallet ${id} not found`);
    const [withTotals] = await this.withTotals([pallet]);
    const lines = await this.lines.find({
      where: { palletId: id },
      order: { createdAt: 'ASC' },
    });
    return { ...withTotals, lines };
  }

  async create(dto: CreatePalletDto): Promise<Pallet> {
    const palletNumber = await this.nextPalletNumber();
    return this.pallets.save(this.pallets.create({ ...dto, palletNumber }));
  }

  async update(id: string, dto: UpdatePalletDto): Promise<PalletWithTotals> {
    await this.assertPallet(id);
    await this.pallets.update(id, dto);
    return (await this.withTotals([await this.pallets.findOneOrFail({ where: { id }, relations: ['location'] })]))[0];
  }

  async remove(id: string): Promise<void> {
    await this.assertPallet(id);
    await this.pallets.delete(id); // cascades pallet_lines
  }

  // --- lines ---

  async addLine(palletId: string, dto: CreatePalletLineDto): Promise<PalletLine> {
    await this.assertPallet(palletId);
    return this.lines.save(this.lines.create({ ...dto, palletId }));
  }

  async updateLine(palletId: string, lineId: string, dto: UpdatePalletLineDto): Promise<PalletLine> {
    const line = await this.lines.findOne({ where: { id: lineId, palletId } });
    if (!line) throw new NotFoundException(`Line ${lineId} not found on pallet ${palletId}`);
    await this.lines.update(lineId, dto);
    return this.lines.findOneOrFail({ where: { id: lineId } });
  }

  async removeLine(palletId: string, lineId: string): Promise<void> {
    const line = await this.lines.findOne({ where: { id: lineId, palletId } });
    if (!line) throw new NotFoundException(`Line ${lineId} not found on pallet ${palletId}`);
    await this.lines.delete(lineId);
  }

  // Totals are always summed live from the lines, never stored, so they can't
  // drift from the counts.
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
    return pallets.map((p) => ({
      ...p,
      totalQuantity: parseInt(map.get(p.id)?.total ?? '0', 10),
      lineCount: parseInt(map.get(p.id)?.lines ?? '0', 10),
    }));
  }

  private async nextPalletNumber(): Promise<string> {
    const result = await this.pallets.query(`SELECT nextval('pallet_number_seq') AS n`);
    const n = String(result[0].n).padStart(6, '0');
    return `PALLET-${n}`;
  }

  private async assertPallet(id: string): Promise<void> {
    const count = await this.pallets.countBy({ id });
    if (count === 0) throw new NotFoundException(`Pallet ${id} not found`);
  }
}
