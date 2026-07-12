import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SalesOrder } from './sales-order.entity';
import { Asset } from '../assets/asset.entity';
import { numericTransformer } from '../common/numeric.transformer';

// One line on a sales order. Either a specific serialized asset (assetId set,
// quantity 1 — traceable to a serial), or a free-text description + quantity
// (bulk/pallet items, or a listing like "10 x Latitude 7490"). unitPrice is the
// agreed sale price per unit.
@Entity('order_lines')
export class OrderLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @ManyToOne(() => SalesOrder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: SalesOrder;

  @Column({ type: 'varchar', nullable: true })
  description: string | null;

  @Column({ name: 'asset_id', type: 'uuid', nullable: true })
  assetId: string | null;

  @ManyToOne(() => Asset, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'asset_id' })
  asset: Asset | null;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({
    name: 'unit_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  unitPrice: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
