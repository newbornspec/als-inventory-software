import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { LookupValue } from './lookup-value.entity';
import { CreateLookupDto } from './dto/create-lookup.dto';
import { UpdateLookupDto } from './dto/update-lookup.dto';
import { QueryLookupsDto } from './dto/query-lookups.dto';

@Injectable()
export class LookupsService {
  constructor(
    @InjectRepository(LookupValue) private lookups: Repository<LookupValue>,
  ) {}

  async findAll(query: QueryLookupsDto): Promise<LookupValue[]> {
    const qb = this.lookups
      .createQueryBuilder('l')
      .orderBy('l.sortOrder', 'ASC')
      .addOrderBy('l.value', 'ASC');
    if (query.category) qb.andWhere('l.category = :category', { category: query.category });
    if (query.parentId) qb.andWhere('l.parentId = :parentId', { parentId: query.parentId });
    if (query.includeInactive !== 'true') qb.andWhere('l.active = true');
    if (query.search) qb.andWhere('l.value ILIKE :s', { s: `%${query.search}%` });
    return qb.getMany();
  }

  // Case-insensitive find-or-create — used when a user types a new dropdown
  // value, so it's saved for reuse without duplicating existing entries.
  async findOrCreate(
    category: string,
    value: string,
    parentId?: string | null,
  ): Promise<LookupValue> {
    const trimmed = value.trim();
    const existing = await this.lookups
      .createQueryBuilder('l')
      .where('l.category = :category', { category })
      .andWhere('LOWER(l.value) = LOWER(:value)', { value: trimmed })
      .andWhere(parentId ? 'l.parentId = :parentId' : 'l.parentId IS NULL', { parentId })
      .getOne();
    if (existing) return existing;
    return this.lookups.save(
      this.lookups.create({ category, value: trimmed, parentId: parentId ?? null }),
    );
  }

  async create(dto: CreateLookupDto): Promise<LookupValue> {
    return this.findOrCreate(dto.category, dto.value, dto.parentId ?? null);
  }

  async update(id: string, dto: UpdateLookupDto): Promise<LookupValue> {
    const found = await this.lookups.findOne({ where: { id } });
    if (!found) throw new NotFoundException(`Lookup ${id} not found`);
    await this.lookups.update(id, {
      ...(dto.value !== undefined ? { value: dto.value.trim() } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    });
    return this.lookups.findOneOrFail({ where: { id } });
  }

  async remove(id: string): Promise<void> {
    const found = await this.lookups.findOne({ where: { id } });
    if (!found) throw new NotFoundException(`Lookup ${id} not found`);
    // Cascade removes dependent children (e.g. a manufacturer's models).
    await this.lookups.delete(id);
  }

  // Convenience: does this value exist for the category? (kept for callers that
  // want to check without creating.)
  async exists(category: string, value: string, parentId?: string | null): Promise<boolean> {
    const n = await this.lookups.count({
      where: { category, value, parentId: parentId ?? IsNull() },
    });
    return n > 0;
  }
}
