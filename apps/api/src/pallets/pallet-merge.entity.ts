import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Pallet } from './pallet.entity';
import { User } from '../users/user.entity';

// One row per SOURCE per merge: "PALLET-000101 contributed 14 lines / 120 units
// to PALLET-000107 on this date, done by this user."
//
// This exists separately from pallet_lines.source_pallet_id because the two
// answer different questions and neither substitutes for the other. The lines
// say where each ITEM came from; this says the merge HAPPENED. Derive the
// merged pallet's "Created from" header from the lines instead and it decays:
// the moment the last line originating from PALLET-000101 is sold, sellLine
// deletes that row and the pallet silently forgets half its own parentage.
//
// source_pallet_id is nullable and ON DELETE SET NULL, so source_pallet_number
// carries the readable label past a deletion.
@Entity('pallet_merges')
export class PalletMerge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'result_pallet_id', type: 'uuid' })
  resultPalletId: string;

  @ManyToOne(() => Pallet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'result_pallet_id' })
  resultPallet: Pallet;

  @Column({ name: 'source_pallet_id', type: 'uuid', nullable: true })
  sourcePalletId: string | null;

  @ManyToOne(() => Pallet, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'source_pallet_id' })
  sourcePallet: Pallet | null;

  // Snapshot — survives deletion of the source.
  @Column({ name: 'source_pallet_number', type: 'varchar' })
  sourcePalletNumber: string;

  @Column({ name: 'units_contributed', type: 'int', default: 0 })
  unitsContributed: number;

  @Column({ name: 'lines_contributed', type: 'int', default: 0 })
  linesContributed: number;

  @Column({ name: 'merged_by_id', type: 'uuid', nullable: true })
  mergedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'merged_by_id' })
  mergedBy: User | null;

  @CreateDateColumn({ name: 'merged_at' })
  mergedAt: Date;
}
