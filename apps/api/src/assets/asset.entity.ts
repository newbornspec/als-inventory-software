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
import { User } from '../users/user.entity';
import { Batch } from '../batches/batch.entity';
import { Lot } from '../batches/lot.entity';
import { Product } from '../products/product.entity';

// Warehouse/lifecycle pipeline — "where is this asset right now".
export enum AssetStockStatus {
  IN_STOCK = 'in_stock',
  OUT_OF_STOCK = 'out_of_stock',
  RECEIVED = 'received',
  AWAITING_AUDIT = 'awaiting_audit',
  AUDITED = 'audited',
  QUARANTINED = 'quarantined',
  ALLOCATED = 'allocated',
  PICKED = 'picked',
  PACKED = 'packed',
  SHIPPED = 'shipped',
  RETURNED = 'returned',
  DISPOSED = 'disposed',
}

// Cosmetic/physical condition grade — independent of stock status.
export enum AssetConditionGrade {
  GRADE_A = 'grade_a',
  GRADE_B = 'grade_b',
  GRADE_C = 'grade_c',
  GRADE_D = 'grade_d',
  FOR_PARTS = 'for_parts',
  SCRAP = 'scrap',
}

// Functional/testing outcome — independent of both of the above.
export enum AssetAuditStatus {
  PASSED_TESTING = 'passed_testing',
  FAILED_TESTING = 'failed_testing',
  POWER_ON = 'power_on',
  NO_POWER = 'no_power',
  POST_FAILED = 'post_failed',
  BIOS_LOCKED = 'bios_locked',
  MISSING_COMPONENTS = 'missing_components',
  DATA_WIPED = 'data_wiped',
  DATA_WIPE_FAILED = 'data_wipe_failed',
  REFURBISHED = 'refurbished',
  READY_FOR_SALE = 'ready_for_sale',
  REPAIR_REQUIRED = 'repair_required',
  BEYOND_ECONOMIC_REPAIR = 'ber',
}

@Entity('assets')
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // The value encoded in the asset's barcode/QR label
  @Column({ unique: true })
  tag: string;

  @Column()
  name: string;

  @Column()
  category: string;

  @Column({
    name: 'stock_status',
    type: 'enum',
    enum: AssetStockStatus,
    default: AssetStockStatus.RECEIVED,
  })
  stockStatus: AssetStockStatus;

  // Denormalized from the most recent AssetAudit row (see asset-audit.entity.ts)
  // so list/filter views don't need to join against audit history for the
  // common case of "show me all Grade B assets" or "show me failed units".
  @Column({
    name: 'condition_grade',
    type: 'enum',
    enum: AssetConditionGrade,
    nullable: true,
  })
  conditionGrade: AssetConditionGrade | null;

  @Column({
    name: 'audit_status',
    type: 'enum',
    enum: AssetAuditStatus,
    nullable: true,
  })
  auditStatus: AssetAuditStatus | null;

  @Column({ name: 'location_id', type: 'uuid', nullable: true })
  locationId: string | null;

  @ManyToOne(() => Location, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'location_id' })
  location: Location | null;

  @Column({ name: 'owner_id', type: 'uuid', nullable: true })
  ownerId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'owner_id' })
  owner: User | null;

  @Column({ name: 'image_url', type: 'varchar', nullable: true })
  imageUrl: string | null;

  // Which receiving event this asset arrived in, and optionally which
  // sub-grouping within it — see apps/api/src/batches for the reconciliation
  // model (expected count on Batch/Lot vs. live COUNT(*) of assets here).
  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId: string | null;

  @ManyToOne(() => Batch, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batch_id' })
  batch: Batch | null;

  @Column({ name: 'lot_id', type: 'uuid', nullable: true })
  lotId: string | null;

  @ManyToOne(() => Lot, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'lot_id' })
  lot: Lot | null;

  // The catalogue entry this unit is an instance of (e.g. "Dell OptiPlex 5050
  // · i5 · 8GB"). Nullable — legacy assets and one-off items may have none.
  // Kept as an additive relation; existing batch/lot fields are untouched.
  @Column({ name: 'product_id', type: 'uuid', nullable: true })
  productId: string | null;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @Column({ name: 'warranty_expires_at', type: 'date', nullable: true })
  warrantyExpiresAt: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
