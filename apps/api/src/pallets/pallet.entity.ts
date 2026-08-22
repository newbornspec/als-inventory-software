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

export enum PalletStatus {
  OPEN = 'open', // being built up / counted
  READY = 'ready', // ready for sale or dispatch
  SHIPPED = 'shipped',
  // TERMINAL, and reachable ONLY through mergePallets — never offered in the
  // status dropdown and explicitly rejected by PATCH, in both directions. A
  // merged pallet has had its lines moved to the pallet that replaced it; it is
  // kept as a historical record, not as stock. Anything that adds or sells
  // lines must refuse it, or the merge invariant breaks from the side.
  MERGED = 'merged',
}

// Which "New Pallet" layout created this pallet. It doesn't change the pallet's
// data — only which export report it generates: VARIANT is Layout 1's original
// report; SPEC is Layout 2's split-column (Manufacturer/Model/…) report.
export enum PalletEntryLayout {
  VARIANT = 'variant',
  SPEC = 'spec',
  // Holds serialized DEVICES (assets.pallet_id points here) instead of
  // quantity lines. One or the other, never both: an asset pallet has no
  // pallet_lines rows, so every consumer that sums that table keeps meaning
  // what it always meant, and its devices stay counted as serialized assets.
  ASSET = 'asset',
}

// A physical pallet holding counted quantities by variant — the monitor case
// from the spec ("Pallet 102: 20 × 22", 35 × 23", 15 × 24"") that was tracked
// in Excel. Unlike serialized assets, the contents aren't individual rows;
// they're PalletLine counts (see pallet-line.entity.ts). The live total is a
// sum of those lines (PalletsService.withTotals), never a stored column, so it
// can't drift.
@Entity('pallets')
export class Pallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'pallet_number', unique: true })
  palletNumber: string;

  @Column({ type: 'varchar', nullable: true })
  description: string | null;

  // Where the pallet's stock was bought from — optional, shown on the report.
  @Column({ type: 'varchar', nullable: true })
  supplier: string | null;

  // Who the whole pallet is being sold to — optional, shown on the report.
  @Column({ type: 'varchar', nullable: true })
  buyer: string | null;

  @Column({ name: 'location_id', type: 'uuid', nullable: true })
  locationId: string | null;

  @ManyToOne(() => Location, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'location_id' })
  location: Location | null;

  @Column({ type: 'enum', enum: PalletStatus, default: PalletStatus.OPEN })
  status: PalletStatus;

  // Which New-Pallet layout created this pallet — drives the export report shape.
  // Free-text varchar (like `tier`) to avoid a rigid pg enum; defaults to VARIANT
  // so Layout 1 and all pre-existing pallets keep the original report.
  @Column({ name: 'entry_layout', type: 'varchar', default: PalletEntryLayout.VARIANT })
  entryLayout: string;

  @Column({ type: 'varchar', nullable: true })
  notes: string | null;

  // Set the moment the pallet is marked shipped; cleared if it's un-shipped.
  // Drives the "Shipped" section and "Shipped on …" on the pallet.
  @Column({ name: 'shipped_at', type: 'timestamp', nullable: true })
  shippedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
