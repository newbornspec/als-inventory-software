import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Asset } from '../assets/asset.entity';
import { User } from '../users/user.entity';
import { numericTransformer } from '../common/numeric.transformer';

export enum RepairStatus {
  PENDING = 'pending', // logged, not started
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANNOT_REPAIR = 'cannot_repair', // beyond economic/technical repair
}

// One repair/refurbishment job on an asset — the work log the audit trail was
// missing. An audit says "needs repair"; this records what was actually done,
// the parts and cost, and by whom. Cost feeds per-asset profit.
@Entity('repair_logs')
export class RepairLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId: string;

  @ManyToOne(() => Asset, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'asset_id' })
  asset: Asset;

  // The fault and/or the work carried out.
  @Column({ type: 'varchar' })
  description: string;

  @Column({ name: 'parts_used', type: 'varchar', nullable: true })
  partsUsed: string | null;

  // Optional repair cost (labour + parts). Nullable so a job saves without it.
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  cost: number | null;

  @Column({ type: 'enum', enum: RepairStatus, default: RepairStatus.PENDING })
  status: RepairStatus;

  @Column({ name: 'performed_by_id', type: 'uuid', nullable: true })
  performedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'performed_by_id' })
  performedBy: User | null;

  @Column({ name: 'completed_at', type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
