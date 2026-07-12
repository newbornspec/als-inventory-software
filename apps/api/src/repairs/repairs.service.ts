import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RepairLog, RepairStatus } from './repair-log.entity';
import { Asset } from '../assets/asset.entity';
import { CreateRepairDto } from './dto/create-repair.dto';
import { UpdateRepairDto } from './dto/update-repair.dto';
import { sanitizeUser } from '../users/sanitize-user';

@Injectable()
export class RepairsService {
  constructor(
    @InjectRepository(RepairLog) private repairs: Repository<RepairLog>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
  ) {}

  async findForAsset(assetId: string): Promise<RepairLog[]> {
    const rows = await this.repairs.find({
      where: { assetId },
      relations: ['performedBy'],
      order: { createdAt: 'DESC' },
    });
    // performedBy is a User — never leak the password hash.
    return rows.map((r) => ({
      ...r,
      performedBy: r.performedBy ? (sanitizeUser(r.performedBy) as RepairLog['performedBy']) : null,
    }));
  }

  async create(assetId: string, dto: CreateRepairDto, userId: string): Promise<RepairLog> {
    await this.assertAsset(assetId);
    const status = dto.status ?? RepairStatus.PENDING;
    return this.repairs.save(
      this.repairs.create({
        assetId,
        description: dto.description,
        partsUsed: dto.partsUsed ?? null,
        cost: dto.cost ?? null,
        status,
        performedById: userId,
        completedAt: status === RepairStatus.COMPLETED ? new Date() : null,
      }),
    );
  }

  async update(assetId: string, id: string, dto: UpdateRepairDto): Promise<RepairLog> {
    const repair = await this.repairs.findOne({ where: { id, assetId } });
    if (!repair) throw new NotFoundException(`Repair ${id} not found on asset ${assetId}`);

    await this.repairs.update(id, dto);

    // Stamp completedAt on the transition into 'completed'; clear it if reopened.
    if (dto.status === RepairStatus.COMPLETED && repair.status !== RepairStatus.COMPLETED) {
      await this.repairs.update(id, { completedAt: new Date() });
    } else if (dto.status && dto.status !== RepairStatus.COMPLETED) {
      await this.repairs.update(id, { completedAt: null });
    }

    return this.repairs.findOneOrFail({ where: { id }, relations: ['performedBy'] });
  }

  async remove(assetId: string, id: string): Promise<void> {
    const repair = await this.repairs.findOne({ where: { id, assetId } });
    if (!repair) throw new NotFoundException(`Repair ${id} not found on asset ${assetId}`);
    await this.repairs.delete(id);
  }

  private async assertAsset(id: string): Promise<void> {
    const count = await this.assets.countBy({ id });
    if (count === 0) throw new NotFoundException(`Asset ${id} not found`);
  }
}
