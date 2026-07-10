import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Batch } from './batch.entity';
import { Product } from '../products/product.entity';

export enum LotStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

// A sub-grouping within a batch. In the redesign this becomes the *sub-lot
// spec bucket*: the operator sets the specification once (either by linking a
// catalogue Product or filling the loose spec columns below), then scans units
// in — each inherits this declared spec. The class keeps the name `Lot` for
// now to avoid renaming the JSON API keys the web app reads; the PurchaseLot /
// SubLot vocabulary rename is a separate, frontend-coordinated step.
// batchId stays nullable — a sub-lot can group units pulled from more than one
// batch, same reasoning as AssetAudit standing alone from Asset.
@Entity('lots')
export class Lot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'lot_number', unique: true })
  lotNumber: string;

  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId: string | null;

  @ManyToOne(() => Batch, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batch_id' })
  batch: Batch | null;

  @Column({ type: 'varchar', nullable: true })
  description: string | null;

  @Column({ name: 'expected_unit_count', type: 'int', nullable: true })
  expectedUnitCount: number | null;

  // --- Declared specification (the sub-lot's identity) ---
  // Preferred path: link a catalogue Product. The loose columns below cover a
  // spec typed in during a blind receive before it's saved to the catalogue.
  @Column({ name: 'product_id', type: 'uuid', nullable: true })
  productId: string | null;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @Column({ type: 'varchar', nullable: true })
  manufacturer: string | null;

  @Column({ type: 'varchar', nullable: true })
  model: string | null;

  @Column({ type: 'varchar', nullable: true })
  cpu: string | null;

  @Column({ name: 'ram_gb', type: 'int', nullable: true })
  ramGb: number | null;

  @Column({ type: 'varchar', nullable: true })
  storage: string | null;

  @Column({ name: 'screen_size', type: 'varchar', nullable: true })
  screenSize: string | null;

  @Column({ type: 'enum', enum: LotStatus, default: LotStatus.OPEN })
  status: LotStatus;

  @Column({ type: 'varchar', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
