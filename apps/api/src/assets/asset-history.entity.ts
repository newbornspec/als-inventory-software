import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Asset } from './asset.entity';
import { User } from '../users/user.entity';

export enum AssetEventType {
  CREATED = 'created',
  SCANNED = 'scanned',
  TRANSFERRED = 'transferred',
  STATUS_CHANGED = 'status_changed', // stock_status changes
  CONDITION_CHANGED = 'condition_changed',
  AUDITED = 'audited',
  RETIRED = 'retired',
}

@Entity('asset_history')
export class AssetHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId: string;

  @ManyToOne(() => Asset, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'asset_id' })
  asset: Asset;

  @Column({ name: 'event_type', type: 'enum', enum: AssetEventType })
  eventType: AssetEventType;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'varchar', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
