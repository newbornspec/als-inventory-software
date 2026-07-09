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

export enum LotStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

// An optional sub-grouping within a batch — e.g. carving "Lot A: 20 Grade-A
// laptops ready for resale" out of a larger received batch. batchId is
// nullable because a lot can also stand alone (grouping assets pulled from
// multiple batches for a single resale shipment), same reasoning as why
// AssetAudit stands alone from Asset rather than being forced into it.
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

  @Column({ type: 'enum', enum: LotStatus, default: LotStatus.OPEN })
  status: LotStatus;

  @Column({ type: 'varchar', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
