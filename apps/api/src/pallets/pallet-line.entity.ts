import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Pallet } from './pallet.entity';
import { Product } from '../products/product.entity';
import { AssetConditionGrade } from '../assets/asset.entity';
import { numericTransformer } from '../common/numeric.transformer';

// One counted line on a pallet: a variant and how many of it. `variant` is free
// text so it works for any grouping the operator uses ("22 inch", "Dell 24 FHD",
// "Grade B 27"") without a rigid catalogue; productId optionally links a
// catalogue entry for reporting, but isn't required.
@Entity('pallet_lines')
export class PalletLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'pallet_id', type: 'uuid' })
  palletId: string;

  @ManyToOne(() => Pallet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pallet_id' })
  pallet: Pallet;

  // --- merge provenance ------------------------------------------------------
  // Where this item came FROM; pallet_id above is where it IS. A merge moves
  // the row rather than copying it, so this is the only record of its origin.
  //
  // ONE HOP, not the whole chain: if A came from X+Y and then A+B merge into C,
  // C's rows point at A and B — the immediate pre-merge parent. The full
  // ancestry is walked through pallet_merges, which is what that table is for.
  //
  // NOTE THE CASCADE DIFFERENCE, which is not an oversight: pallet_id above is
  // ON DELETE CASCADE, this is ON DELETE SET NULL. Deleting a merged-away
  // original must never delete the surviving pallet's stock.
  @Column({ name: 'source_pallet_id', type: 'uuid', nullable: true })
  sourcePalletId: string | null;

  @ManyToOne(() => Pallet, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'source_pallet_id' })
  sourcePallet: Pallet | null;

  // Snapshot — readable even once the source pallet is deleted and the FK above
  // has gone null. Same idiom as pallet_sold_lines.pallet_number.
  @Column({ name: 'source_pallet_number', type: 'varchar', nullable: true })
  sourcePalletNumber: string | null;

  // A composed display label ("Dell · P2419H · 24\" · Frameless · Stand").
  // NOT NULL and load-bearing — the report, the sold snapshot and sold-return
  // matching all read it — so the server composes it from the fields below
  // rather than asking the operator to type it.
  @Column({ type: 'varchar' })
  variant: string;

  // --- Layout 1 spec columns -------------------------------------------------
  // One pallet line is one product/variant combination, mirroring the sheet the
  // warehouse keeps by hand. All nullable: rows created before these existed
  // simply have none, and a half-filled row is still worth saving.
  @Column({ type: 'varchar', nullable: true })
  manufacturer: string | null;

  @Column({ type: 'varchar', nullable: true })
  model: string | null;

  // Screen size as the label the dropdown offers, e.g. '24"' or '19/20"'.
  @Column({ type: 'varchar', nullable: true })
  size: string | null;

  // 'normal' | 'frameless'. Named variantType because `variant` above is taken.
  @Column({ name: 'variant_type', type: 'varchar', nullable: true })
  variantType: string | null;

  // true = Yes, false = No, NULL = not recorded. Nullable rather than defaulting
  // to false so an old row reads "unknown" instead of asserting "no stand".
  @Column({ type: 'boolean', nullable: true })
  stand: boolean | null;

  // Sale tier for this variant (e.g. "tier_1", "tier_2"); NULL means none.
  // Free text so new tiers need no schema change.
  @Column({ type: 'varchar', nullable: true })
  tier: string | null;

  @Column({ type: 'int', default: 0 })
  quantity: number;

  // Cosmetic grade for this variant — same scale as serialized assets.
  @Column({ type: 'enum', enum: AssetConditionGrade, nullable: true })
  grade: AssetConditionGrade | null;

  // Optional per-unit cost for this variant — feeds pallet valuation/reporting.
  // Never required, so a line always saves even with no cost entered.
  @Column({
    name: 'unit_cost',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  unitCost: number | null;

  @Column({ name: 'product_id', type: 'uuid', nullable: true })
  productId: string | null;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
