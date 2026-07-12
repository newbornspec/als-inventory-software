import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SalesOrder } from './sales-order.entity';
import { OrderLine } from './order-line.entity';
import { Asset, AssetStockStatus } from '../assets/asset.entity';
import { AssetHistory, AssetEventType } from '../assets/asset-history.entity';
import { CreateSalesOrderDto } from './dto/create-sales-order.dto';
import { UpdateSalesOrderDto } from './dto/update-sales-order.dto';
import { CreateOrderLineDto } from './dto/create-order-line.dto';
import { UpdateOrderLineDto } from './dto/update-order-line.dto';

// Once an order reaches one of these, its serialized assets are considered gone
// from stock (shipped to the customer).
const FULFILLED_STATUSES = ['shipped', 'completed'];

export interface OrderWithTotals extends SalesOrder {
  total: number;
  lineCount: number;
}

@Injectable()
export class SalesService {
  constructor(
    @InjectRepository(SalesOrder) private orders: Repository<SalesOrder>,
    @InjectRepository(OrderLine) private lines: Repository<OrderLine>,
    @InjectRepository(Asset) private assets: Repository<Asset>,
    @InjectRepository(AssetHistory) private history: Repository<AssetHistory>,
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
    const before = await this.orders.findOne({ where: { id } });
    if (!before) throw new NotFoundException(`Order ${id} not found`);
    await this.orders.update(id, dto);
    const updated = await this.orders.findOneOrFail({ where: { id }, relations: ['customer'] });
    // Ship the serialized assets exactly once, on the transition INTO a fulfilled
    // status (not on every subsequent edit while already shipped/completed).
    if (
      dto.status &&
      FULFILLED_STATUSES.includes(dto.status) &&
      !FULFILLED_STATUSES.includes(before.status)
    ) {
      await this.fulfilAssets(updated);
    }
    return (await this.withTotals([updated]))[0];
  }

  async remove(id: string): Promise<void> {
    await this.assertOrder(id);
    await this.orders.delete(id); // cascades order_lines
  }

  // --- lines ---

  async addLine(orderId: string, dto: CreateOrderLineDto): Promise<OrderLine> {
    await this.assertOrder(orderId);
    let assetId = dto.assetId ?? null;
    let description = dto.description ?? null;

    // Scanned/typed serial → resolve to a specific asset and guard against
    // selling a unit that has already left the building.
    if (dto.assetTag) {
      const tag = dto.assetTag.trim();
      const asset = await this.assets
        .createQueryBuilder('a')
        .where('LOWER(a.tag) = LOWER(:tag)', { tag })
        .getOne();
      if (!asset) {
        throw new BadRequestException(`No asset found with serial/tag "${tag}".`);
      }
      if (
        asset.stockStatus === AssetStockStatus.SHIPPED ||
        asset.stockStatus === AssetStockStatus.DISPOSED
      ) {
        throw new BadRequestException(
          `Asset ${asset.tag} is already ${asset.stockStatus} and can't be sold again.`,
        );
      }
      assetId = asset.id;
      description = description ?? `${asset.tag} — ${asset.name}`;
    }

    if (!assetId && !description) {
      throw new BadRequestException('A line needs either an asset/serial or a description.');
    }
    return this.lines.save(
      this.lines.create({
        orderId,
        assetId,
        description,
        quantity: assetId ? 1 : (dto.quantity ?? 1),
        unitPrice: dto.unitPrice ?? null,
      }),
    );
  }

  // On fulfilment, move each serialized asset on the order to SHIPPED and record
  // it in the append-only history — that's the "which serial went out on which
  // order" traceability the old tool lost by deleting sold assets.
  private async fulfilAssets(order: SalesOrder): Promise<void> {
    const lines = await this.lines.find({ where: { orderId: order.id } });
    const assetIds = lines.map((l) => l.assetId).filter((x): x is string => !!x);
    for (const assetId of assetIds) {
      await this.assets.update({ id: assetId }, { stockStatus: AssetStockStatus.SHIPPED });
      await this.history.save(
        this.history.create({
          assetId,
          eventType: AssetEventType.STATUS_CHANGED,
          userId: null,
          notes: `Shipped on order ${order.orderNumber}`,
        }),
      );
    }
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
