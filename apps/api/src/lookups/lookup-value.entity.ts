import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// The set of dropdown fields Layout 2 (and future forms) draw from. Kept as a
// plain string list rather than a DB enum so a new field (e.g. 'gpu') needs no
// migration — just add it here and to the DTO's allow-list.
export const LOOKUP_CATEGORIES = [
  'manufacturer',
  'model',
  'chassis',
  'cpu',
  'ram',
  'storage',
] as const;
export type LookupCategory = (typeof LOOKUP_CATEGORIES)[number];

// A single reusable value for a searchable dropdown ("Dell", "OptiPlex 3080",
// "16 GB"…). Master lookup data, managed by admins and grown on the fly when a
// user types a new value. `parentId` gives dependent lists their scope — a
// 'model' points at its 'manufacturer' value so Dell only shows Dell models.
@Entity('lookup_values')
export class LookupValue {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar' })
  category: string;

  @Column({ type: 'varchar' })
  value: string;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  @ManyToOne(() => LookupValue, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_id' })
  parent: LookupValue | null;

  // Disabled values stay for history/existing records but drop out of dropdowns.
  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
