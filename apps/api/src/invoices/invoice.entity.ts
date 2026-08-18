import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Pallet } from '../pallets/pallet.entity';
import { User } from '../users/user.entity';
import { numericTransformer } from '../common/numeric.transformer';

// One line as it appeared on the invoice when it was raised. Stored as JSON on
// the invoice rather than joined, because selling a pallet line deletes it —
// see the migration for the full reasoning.
export interface InvoiceLine {
  manufacturer: string | null;
  model: string | null;
  size: string | null;
  variantType: string | null;
  stand: boolean | null;
  grade: string | null;
  quantity: number;
  unitPrice: number | null;
  lineTotal: number | null;
}

@Entity('invoices')
export class Invoice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // INV-2026-0001. Unique across all years; the year segment comes from
  // invoice_year, allocated together in one statement.
  @Column({ name: 'invoice_number', type: 'varchar', unique: true })
  invoiceNumber: string;

  @Column({ name: 'invoice_year', type: 'int' })
  invoiceYear: number;

  @Column({ name: 'invoice_date', type: 'date' })
  invoiceDate: string;

  // Navigation only. The invoice survives the pallet being deleted.
  @Index()
  @Column({ name: 'pallet_id', type: 'uuid', nullable: true })
  palletId: string | null;

  @ManyToOne(() => Pallet, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'pallet_id' })
  pallet: Pallet | null;

  @Column({ name: 'pallet_number', type: 'varchar' })
  palletNumber: string;

  // --- buyer, snapshotted ----------------------------------------------------
  @Column({ name: 'buyer_name', type: 'varchar' })
  buyerName: string;

  @Column({ name: 'buyer_address1', type: 'varchar', nullable: true })
  buyerAddress1: string | null;

  @Column({ name: 'buyer_address2', type: 'varchar', nullable: true })
  buyerAddress2: string | null;

  @Column({ name: 'buyer_city', type: 'varchar', nullable: true })
  buyerCity: string | null;

  @Column({ name: 'buyer_postcode', type: 'varchar', nullable: true })
  buyerPostcode: string | null;

  @Column({ name: 'buyer_country', type: 'varchar', nullable: true })
  buyerCountry: string | null;

  // --- VAT, snapshotted ------------------------------------------------------
  // The boolean is what the document reads. Nothing infers "not registered"
  // from a missing rate, so an unfilled form can never silently print as
  // zero-rated.
  @Column({ name: 'vat_registered', type: 'boolean', default: false })
  vatRegistered: boolean;

  @Column({ name: 'vat_number', type: 'varchar', nullable: true })
  vatNumber: string | null;

  // Stored as a percentage (20 means 20%), matching how a person states it.
  @Column({
    name: 'vat_rate',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  vatRate: number | null;

  // --- money, stored not computed -------------------------------------------
  // An issued invoice must reprint identically. Recomputing from lines that
  // could later be edited would let a reprint disagree with what was sent.
  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: numericTransformer })
  subtotal: number;

  @Column({
    name: 'vat_amount',
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  vatAmount: number;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: numericTransformer })
  total: number;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  lines: InvoiceLine[];

  @Column({ type: 'varchar', nullable: true })
  notes: string | null;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_id' })
  createdBy: User | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
