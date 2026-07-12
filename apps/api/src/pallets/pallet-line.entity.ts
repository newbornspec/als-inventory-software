import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Pallet } from './pallet.entity';
import { Product } from '../products/product.entity';
import { numericTransformer } from '../common/numeric.transformer';

// One counted line on a pallet: a variant and how many of it. `variant` is free
// text so it works for any grouping the operator uses ("22 inch", "Dell 24 FHD",
// "Grade B 27"") without a rigid catalogue; productId optionally links a
// catalogue entry for reporting, but isn't required.
@Entity('pallet_lines')
export class PalletLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'pallet_id', type: 'uuid' })
  palletId: string;

  @ManyToOne(() => Pallet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pallet_id' })
  pallet: Pallet;

  @Column({ type: 'varchar' })
  variant: string;

  @Column({ type: 'int', default: 0 })
  quantity: number;

  // Optional per-unit cost for this variant — feeds pallet valuation/reporting.
  // Never required, so a line always saves even with no cost entered.
  @Column({
    name: 'unit_cost',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  unitCost: number | null;

  @Column({ name: 'product_id', type: 'uuid', nullable: true })
  productId: string | null;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
