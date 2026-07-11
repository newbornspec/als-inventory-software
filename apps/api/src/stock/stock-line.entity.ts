import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Location } from '../locations/location.entity';
import { Product } from '../products/product.entity';

// Quantity-tracked, non-serialized stock — the low-value consumables from the
// spec (keyboards, mice, power cables) that aren't worth tracking per-unit.
// A stock line is "how many of item X are at location Y". `quantity` is the
// current on-hand; every change is also recorded as a StockMovement so there's
// a full audit trail (see stock-movement.entity.ts). name/sku are held inline
// so it's usable without a rigid catalogue; productId optionally links one.
@Entity('stock_lines')
export class StockLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'varchar', nullable: true })
  sku: string | null;

  @Column({ type: 'varchar', nullable: true })
  category: string | null;

  @Column({ name: 'product_id', type: 'uuid', nullable: true })
  productId: string | null;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @Column({ name: 'location_id', type: 'uuid', nullable: true })
  locationId: string | null;

  @ManyToOne(() => Location, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'location_id' })
  location: Location | null;

  @Column({ type: 'int', default: 0 })
  quantity: number;

  @Column({ type: 'varchar', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
