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
  SOLD = 'sold',
  ADJUSTED = 'adjusted', // manual correction / recount
  RETURNED = 'returned',
  SCRAPPED = 'scrapped',
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
