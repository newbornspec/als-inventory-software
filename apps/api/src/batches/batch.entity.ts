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

export enum BatchStatus {
  DRAFT = 'draft', // purchase lot created before goods arrive; details still being filled in
  AWAITING_ARRIVAL = 'awaiting_arrival', // purchased, expected, not yet physically received
  OPEN = 'open', // created, not yet receiving
  RECEIVING = 'receiving', // actively being scanned in
  CLOSED = 'closed', // receiving finished
  RECONCILED = 'reconciled', // actual count checked against expected, discrepancies resolved
}

// A single intake event — e.g. "50 laptops from Acme Corp decommission,
// received 2026-07-09". expectedUnitCount is the manifest/declared count;
// the actual count is never stored here (see BatchesService.withCounts) —
// it's always a live COUNT(*) of assets pointing at this batch, so it can
// never drift out of sync with what's actually been scanned in.
@Entity('batches')
export class Batch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'batch_number', unique: true })
  batchNumber: string;

  @Column({ type: 'varchar', nullable: true })
  source: string | null; // client/vendor the batch came from

  @Column({ name: 'location_id', type: 'uuid', nullable: true })
  locationId: string | null;

  @ManyToOne(() => Location, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'location_id' })
  location: Location | null;

  @Column({ name: 'received_by_id', type: 'uuid', nullable: true })
  receivedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'received_by_id' })
  receivedBy: User | null;

  @Column({ name: 'received_date', type: 'date', nullable: true })
  receivedDate: string | null;

  // --- Pre-arrival purchasing details (a lot can exist before goods land) ---
  @Column({ name: 'purchase_order', type: 'varchar', nullable: true })
  purchaseOrder: string | null;

  @Column({ name: 'delivery_note', type: 'varchar', nullable: true })
  deliveryNote: string | null;

  @Column({ name: 'purchase_date', type: 'date', nullable: true })
  purchaseDate: string | null;

  @Column({ name: 'expected_unit_count', type: 'int', nullable: true })
  expectedUnitCount: number | null;

  @Column({ type: 'enum', enum: BatchStatus, default: BatchStatus.OPEN })
  status: BatchStatus;

  @Column({ type: 'varchar', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
