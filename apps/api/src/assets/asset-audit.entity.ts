import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Asset, AssetAuditStatus, AssetConditionGrade } from './asset.entity';
import { User } from '../users/user.entity';
import { HardwareProfile } from '../devices/hardware-profile.type';

export enum DataWipeStatus {
  NOT_STARTED = 'not_started',
  WIPED = 'wiped',
  FAILED = 'failed',
}

export enum FinalDisposition {
  SELL = 'sell',
  REPAIR = 'repair',
  PARTS = 'parts',
  RECYCLE = 'recycle',
}

// A per-component pass/fail checklist — kept as JSONB rather than fixed
// columns because the relevant checklist varies by asset type (a monitor
// has no keyboard to test; a laptop has no such thing as "port count").
export interface FunctionalTestResults {
  keyboard?: 'pass' | 'fail' | 'n/a';
  ports?: 'pass' | 'fail' | 'n/a';
  webcam?: 'pass' | 'fail' | 'n/a';
  wifi?: 'pass' | 'fail' | 'n/a';
  speakers?: 'pass' | 'fail' | 'n/a';
  [key: string]: string | undefined;
}

// One row per audit event — an asset gets re-audited over its life (received,
// pre-resale, post-repair), and ITAD compliance requires keeping the full
// trail, not just the latest snapshot. Asset.conditionGrade/auditStatus are
// denormalized from the most recent row here for fast list filtering.
@Entity('asset_audits')
export class AssetAudit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId: string;

  @ManyToOne(() => Asset, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'asset_id' })
  asset: Asset;

  @Column({
    name: 'audit_status',
    type: 'enum',
    enum: AssetAuditStatus,
    nullable: true,
  })
  auditStatus: AssetAuditStatus | null;

  @Column({ type: 'varchar', nullable: true })
  manufacturer: string | null;

  @Column({ type: 'varchar', nullable: true })
  model: string | null;

  @Column({ name: 'serial_number', type: 'varchar', nullable: true })
  serialNumber: string | null;

  @Column({ type: 'varchar', nullable: true })
  cpu: string | null;

  @Column({ name: 'ram_gb', type: 'int', nullable: true })
  ramGb: number | null;

  @Column({ name: 'storage_capacity', type: 'varchar', nullable: true })
  storageCapacity: string | null;

  @Column({ name: 'screen_size', type: 'varchar', nullable: true })
  screenSize: string | null;

  @Column({ name: 'screen_resolution', type: 'varchar', nullable: true })
  screenResolution: string | null;

  @Column({ name: 'battery_health', type: 'varchar', nullable: true })
  batteryHealth: string | null;

  @Column({
    name: 'cosmetic_grade',
    type: 'enum',
    enum: AssetConditionGrade,
    nullable: true,
  })
  cosmeticGrade: AssetConditionGrade | null;

  @Column({ name: 'functional_tests', type: 'jsonb', nullable: true })
  functionalTests: FunctionalTestResults | null;

  // Full auto-captured hardware profile snapshot for this audit event — the
  // append-only compliance trail. See devices/hardware-profile.type.ts.
  @Column({ name: 'hardware_profile', type: 'jsonb', nullable: true })
  hardwareProfile: HardwareProfile | null;

  @Column({ name: 'bios_locked', type: 'boolean', nullable: true })
  biosLocked: boolean | null;

  @Column({ name: 'charger_included', type: 'boolean', nullable: true })
  chargerIncluded: boolean | null;

  @Column({
    name: 'data_wipe_status',
    type: 'enum',
    enum: DataWipeStatus,
    nullable: true,
  })
  dataWipeStatus: DataWipeStatus | null;

  // e.g. "NIST 800-88 Purge" — ITAD compliance reporting needs the method,
  // not just a wiped/not-wiped flag.
  @Column({ name: 'data_wipe_method', type: 'varchar', nullable: true })
  dataWipeMethod: string | null;

  @Column({
    name: 'final_disposition',
    type: 'enum',
    enum: FinalDisposition,
    nullable: true,
  })
  finalDisposition: FinalDisposition | null;

  @Column({ type: 'varchar', nullable: true })
  notes: string | null;

  @Column({ name: 'audited_by_id', type: 'uuid', nullable: true })
  auditedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'audited_by_id' })
  auditedBy: User | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
