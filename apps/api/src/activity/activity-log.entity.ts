import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

// System-wide audit trail: one row per meaningful action (who did what, to
// which entity, when). Distinct from AssetHistory (which is an asset-only
// timeline) — this spans batches, assets, imports, audits, etc.
@Entity('activity_log')
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  // Machine-readable action slug, e.g. "batch.created", "asset.updated".
  @Column({ type: 'varchar' })
  action: string;

  // What kind of thing it touched ("batch" | "asset" | "expected" | …) and its id.
  @Column({ name: 'entity_type', type: 'varchar', nullable: true })
  entityType: string | null;

  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  entityId: string | null;

  // Human-readable one-liner, e.g. "Created BATCH-000021".
  @Column({ type: 'text' })
  summary: string;

  @Index()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
