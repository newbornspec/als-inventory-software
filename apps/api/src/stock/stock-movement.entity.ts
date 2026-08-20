import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { StockLine } from './stock-line.entity';

export enum StockMovementReason {
  RECEIVED = 'received',
  USED = 'used', // consumed internally (was 'sold' — consumables aren't sold)
  ADJUSTED = 'adjusted', // manual correction / recount
  RETURNED = 'returned',
  SCRAPPED = 'scrapped',
  // One move writes TWO of these: -n on the source line, +n on the destination.
  // Not 'adjusted', or a transfer would read as stock vanishing at one location
  // and appearing at another rather than moving between them.
  TRANSFERRED = 'transferred',
}

// Append-only log of every quantity change on a stock line: +delta in, -delta
// out. The line's stored quantity always equals the sum of these, so the count
// is both fast to read and fully auditable ("where did those 20 go?").
@Entity('stock_movements')
export class StockMovement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'stock_line_id', type: 'uuid' })
  stockLineId: string;

  @ManyToOne(() => StockLine, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'stock_line_id' })
  stockLine: StockLine;

  @Column({ type: 'int' })
  delta: number;

  @Column({ type: 'enum', enum: StockMovementReason })
  reason: StockMovementReason;

  @Column({ type: 'varchar', nullable: true })
  note: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  // --- Transfers only. Null on every other reason, and on all history. ---
  // Shared by both halves of one move, so the -n and the +n can be shown as the
  // single event they are rather than two unrelated rows.
  @Column({ name: 'transfer_id', type: 'uuid', nullable: true })
  transferId: string | null;

  // Where it went, recorded as IDs rather than names so renaming a location
  // cannot make history lie about it.
  @Column({ name: 'from_location_id', type: 'uuid', nullable: true })
  fromLocationId: string | null;

  @Column({ name: 'to_location_id', type: 'uuid', nullable: true })
  toLocationId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
