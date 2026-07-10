import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product) private products: Repository<Product>,
  ) {}

  findAll(query: QueryProductsDto): Promise<Product[]> {
    const qb = this.products.createQueryBuilder('product');

    if (query.search) {
      // Match the catalogue the way an operator would search it — by name,
      // SKU or model — so "5050" or "elitebook" both land.
      qb.andWhere(
        '(product.name ILIKE :s OR product.sku ILIKE :s OR product.model ILIKE :s)',
        { s: `%${query.search}%` },
      );
    }
    if (query.trackingType) {
      qb.andWhere('product.trackingType = :tt', { tt: query.trackingType });
    }
    if (query.category) {
      qb.andWhere('product.category = :c', { c: query.category });
    }

    return qb.orderBy('product.name', 'ASC').getMany();
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.products.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return product;
  }

  create(dto: CreateProductDto): Promise<Product> {
    return this.products.save(this.products.create(dto));
  }

  async update(id: string, dto: UpdateProductDto): Promise<Product> {
    // Load-merge-save rather than repo.update(): the jsonb `attributes` column
    // doesn't fit TypeORM's QueryDeepPartialEntity typing for a partial update,
    // and save() round-trips jsonb cleanly. Absent DTO fields aren't own
    // properties, so Object.assign only writes what the PATCH actually sent.
    const product = await this.findOne(id); // 404s if missing
    Object.assign(product, dto);
    return this.products.save(product);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.products.delete(id);
  }
}
