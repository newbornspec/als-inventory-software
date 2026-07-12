import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SalesOrder } from './sales-order.entity';
import { OrderLine } from './order-line.entity';
import { CreateSalesOrderDto } from './dto/create-sales-order.dto';
import { UpdateSalesOrderDto } from './dto/update-sales-order.dto';
import { CreateOrderLineDto } from './dto/create-order-line.dto';
import { UpdateOrderLineDto } from './dto/update-order-line.dto';

export interface OrderWithTotals extends SalesOrder {
  total: number;
  lineCount: number;
}

@Injectable()
export class SalesService {
  constructor(
    @InjectRepository(SalesOrder) private orders: Repository<SalesOrder>,
    @InjectRepository(OrderLine) private lines: Repository<OrderLine>,
  ) {}

  async findAll(): Promise<OrderWithTotals[]> {
    const orders = await this.orders.find({
      relations: ['customer'],
      order: { createdAt: 'DESC' },
    });
    return this.withTotals(orders);
  }

  async findOne(id: string): Promise<OrderWithTotals & { lines: OrderLine[] }> {
    const order = await this.orders.findOne({ where: { id }, relations: ['customer'] });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    const [withTotals] = await this.withTotals([order]);
    const lines = await this.lines.find({
      where: { orderId: id },
      relations: ['asset'],
      order: { createdAt: 'ASC' },
    });
    return { ...withTotals, lines };
  }

  async create(dto: CreateSalesOrderDto): Promise<SalesOrder> {
    const orderNumber = await this.nextOrderNumber();
    return this.orders.save(this.orders.create({ ...dto, orderNumber }));
  }

  async update(id: string, dto: UpdateSalesOrderDto): Promise<OrderWithTotals> {
    await this.assertOrder(id);
    await this.orders.update(id, dto);
    const updated = await this.orders.findOneOrFail({ where: { id }, relations: ['customer'] });
    return (await this.withTotals([updated]))[0];
  }

  async remove(id: string): Promise<void> {
    await this.assertOrder(id);
    await this.orders.delete(id); // cascades order_lines
  }

  // --- lines ---

  async addLine(orderId: string, dto: CreateOrderLineDto): Promise<OrderLine> {
    await this.assertOrder(orderId);
    if (!dto.assetId && !dto.description) {
      throw new BadRequestException('A line needs either an asset or a description.');
    }
    return this.lines.save(
      this.lines.create({
        orderId,
        assetId: dto.assetId ?? null,
        description: dto.description ?? null,
        quantity: dto.assetId ? 1 : (dto.quantity ?? 1),
        unitPrice: dto.unitPrice ?? null,
      }),
    );
  }

  async updateLine(orderId: string, lineId: string, dto: UpdateOrderLineDto): Promise<OrderLine> {
    const line = await this.lines.findOne({ where: { id: lineId, orderId } });
    if (!line) throw new NotFoundException(`Line ${lineId} not found on order ${orderId}`);
    await this.lines.update(lineId, dto);
    return this.lines.findOneOrFail({ where: { id: lineId }, relations: ['asset'] });
  }

  async removeLine(orderId: string, lineId: string): Promise<void> {
    const line = await this.lines.findOne({ where: { id: lineId, orderId } });
    if (!line) throw new NotFoundException(`Line ${lineId} not found on order ${orderId}`);
    await this.lines.delete(lineId);
  }

  // Order total summed live from the lines (quantity * unit price).
  private async withTotals(orders: SalesOrder[]): Promise<OrderWithTotals[]> {
    if (orders.length === 0) return [];
    const rows = await this.lines
      .createQueryBuilder('line')
      .select('line.orderId', 'orderId')
      .addSelect('COALESCE(SUM(line.quantity * COALESCE(line.unitPrice, 0)), 0)', 'total')
      .addSelect('COUNT(*)', 'lines')
      .where('line.orderId IN (:...ids)', { ids: orders.map((o) => o.id) })
      .groupBy('line.orderId')
      .getRawMany<{ orderId: string; total: string; lines: string }>();
    const map = new Map(rows.map((r) => [r.orderId, r]));
    return orders.map((o) => ({
      ...o,
      total: parseFloat(map.get(o.id)?.total ?? '0'),
      lineCount: parseInt(map.get(o.id)?.lines ?? '0', 10),
    }));
  }

  private async nextOrderNumber(): Promise<string> {
    const result = await this.orders.query(`SELECT nextval('order_number_seq') AS n`);
    const n = String(result[0].n).padStart(6, '0');
    return `SO-${n}`;
  }

  private async assertOrder(id: string): Promise<void> {
    const count = await this.orders.countBy({ id });
    if (count === 0) throw new NotFoundException(`Order ${id} not found`);
  }
}
