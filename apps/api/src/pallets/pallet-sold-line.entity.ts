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
import { User } from '../users/user.entity';
import { numericTransformer } from '../common/numeric.transformer';

// A quantity that was sold off a pallet — the Sold-page archive row for pallet
// goods. Snapshots the variant/product/pallet number so the record survives
// later edits or even deletion of the pallet. `returned_*` is stamped when an
// admin returns the quantity to a pallet; returned rows drop off the Sold page
// but stay here as the audit trail.
@Entity('pallet_sold_lines')
export class PalletSoldLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'pallet_id', type: 'uuid', nullable: true })
  palletId: string | null;

  @ManyToOne(() => Pallet, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'pallet_id' })
  pallet: Pallet | null;

  // Snapshot — readable even if the pallet is deleted.
  @Column({ name: 'pallet_number', type: 'varchar' })
  palletNumber: string;

  @Column({ name: 'product_id', type: 'uuid', nullable: true })
  productId: string | null;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @Column({ type: 'varchar' })
  variant: string;

  @Column({ type: 'int' })
  quantity: number;

  // Total sale amount for this row (all `quantity` units) — optional.
  @Column({
    name: 'sale_total',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  saleTotal: number | null;

  // The line's per-unit cost at the moment of sale, snapshotted so profit is
  // computable after the source line is decremented/removed.
  @Column({
    name: 'unit_cost',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  unitCost: number | null;

  @CreateDateColumn({ name: 'sold_at' })
  soldAt: Date;

  @Column({ name: 'sold_by_id', type: 'uuid', nullable: true })
  soldById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sold_by_id' })
  soldBy: User | null;

  @Column({ name: 'returned_at', type: 'timestamp', nullable: true })
  returnedAt: Date | null;

  @Column({ name: 'returned_by_id', type: 'uuid', nullable: true })
  returnedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'returned_by_id' })
  returnedBy: User | null;

  @Column({ name: 'returned_to_pallet_id', type: 'uuid', nullable: true })
  returnedToPalletId: string | null;
}
