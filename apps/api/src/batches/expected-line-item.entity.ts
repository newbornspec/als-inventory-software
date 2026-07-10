import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Batch } from './batch.entity';

// How an expected line compares to what was physically received. Everything
// starts PENDING at import; receiving verification (a later phase) sets the
// rest by diffing expected rows against scanned assets.
export enum ExpectedLineVerificationStatus {
  PENDING = 'pending', // imported, not yet checked against physical stock
  FOUND = 'found', // a matching device was scanned in
  MISSING = 'missing', // expected but never scanned
  MISMATCH = 'mismatch', // matched, but spec/grade differs from the manifest
  EXTRA = 'extra', // scanned but not on the supplier list
}

// One row of a supplier's asset list, imported against a purchase lot BEFORE
// (or as) goods arrive — the "expected inventory". Suppliers vary wildly in
// what they provide, so every spec field is nullable; only quantity is always
// meaningful (defaults to 1 for serial-level lists). This is the manifest that
// receiving verification later diffs the actual scanned devices against.
@Entity('expected_line_items')
export class ExpectedLineItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // The purchase lot (batches table) this expected line belongs to.
  @Column({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  @ManyToOne(() => Batch, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'batch_id' })
  batch: Batch;

  @Column({ name: 'asset_tag', type: 'varchar', nullable: true })
  assetTag: string | null;

  @Column({ name: 'serial_number', type: 'varchar', nullable: true })
  serialNumber: string | null;

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

  // Supplier's stated condition and grade — free text, since every supplier
  // uses their own vocabulary ("Grade B", "used - good", "A/B", …).
  @Column({ type: 'varchar', nullable: true })
  condition: string | null;

  @Column({ type: 'varchar', nullable: true })
  grade: string | null;

  // 1 for serial-level lists; higher for "20 × Dell keyboards" style lines.
  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({
    name: 'verification_status',
    type: 'enum',
    enum: ExpectedLineVerificationStatus,
    default: ExpectedLineVerificationStatus.PENDING,
  })
  verificationStatus: ExpectedLineVerificationStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
