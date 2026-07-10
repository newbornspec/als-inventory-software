import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// Which of the three inventory tiers a catalogue entry belongs to. The tier
// decides where physical stock of this product lives: SERIALIZED assets get
// one Asset row each; BULK is a counted StockLine; PALLET is a variant-quantity
// container. A product's tier is fixed once stock exists against it.
export enum ProductTrackingType {
  SERIALIZED = 'serialized', // laptops, desktops, servers — one row per unit
  BULK = 'bulk', // keyboards, mice, cables — SKU + count
  PALLET = 'pallet', // monitors — quantity by variant on a pallet
}

// The catalogue / SKU layer that sits above all three inventory tiers. A
// Product is a *definition* ("Dell OptiPlex 5050 · i5 · 8GB", "USB keyboard"),
// never stock itself — the tiers reference it. It's what lets one search box
// and one report span serialized, bulk and pallet inventory, and what a
// sub-lot's declared spec resolves to so specs stay consistent (a manually
// typed spec can be saved here for reuse). Additive and standalone — nothing
// existing depends on it, so introducing it can't affect current data.
@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Optional human SKU. Nullable so a catalogue entry can exist before it's
  // assigned one; Postgres UNIQUE permits multiple NULLs.
  @Column({ type: 'varchar', unique: true, nullable: true })
  sku: string | null;

  @Column()
  name: string;

  // Free-text to match Asset.category (kept a string, not an enum, on purpose).
  @Column({ type: 'varchar', nullable: true })
  category: string | null;

  @Column({
    name: 'tracking_type',
    type: 'enum',
    enum: ProductTrackingType,
    default: ProductTrackingType.SERIALIZED,
  })
  trackingType: ProductTrackingType;

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

  // Anything beyond the common columns above (GPU, ports, form factor, …) —
  // the spec shape varies by product type, same reasoning as AssetAudit's
  // functional_tests JSONB.
  @Column({ type: 'jsonb', nullable: true })
  attributes: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
