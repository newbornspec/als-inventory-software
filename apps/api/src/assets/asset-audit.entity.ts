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
// Type-only: erased at runtime, so no import cycle with manual-wipe.ts.
import type { WipeSource } from './manual-wipe';
import type { WipedDrive, WipeSmart } from '../devices/wipe-detail';

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

  // The screen, graded separately from the casing. A scratched lid with a
  // perfect panel is a different product from a pristine lid with a cracked
  // one, and resale price follows the screen much more closely - grading them
  // together threw that away at the one moment it is cheap to record.
  //
  // Same enum as cosmetic_grade so the two are directly comparable. NULL means
  // not graded, which covers desktops with no screen and any operator who
  // simply did not judge it; neither is an error.
  @Column({
    name: 'screen_grade',
    type: 'enum',
    enum: AssetConditionGrade,
    nullable: true,
  })
  screenGrade: AssetConditionGrade | null;

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

  // 'station' | 'manual' - who recorded the wipe outcome, and so what the
  // certificate may claim. Set by the SERVER only: the station ingest writes
  // 'station', the web routes write 'manual', and anything a client sends for
  // it is discarded. Null when no wipe status was recorded. See manual-wipe.ts
  // and migration 1752640000000-AddWipeSource.
  @Column({ name: 'wipe_source', type: 'varchar', length: 16, nullable: true })
  wipeSource: WipeSource | null;

  // --- per-drive wipe detail (remediation spec steps 19, 26, 39) ----------
  // All NULL on rows from before migration 1752650000000-AddWipeRecordDetail,
  // on rows from sticks that predate these fields, and on non-wipe audits.
  // Written only by the station ingest, through devices/wipe-detail.ts, which
  // stores NULL plus a note for anything it cannot accept rather than
  // rejecting the record. Not in the PowerSync upload allow-list, so no web
  // client can set them.

  // When the drive was erased, by the station's clock (created_at is when the
  // record reached the server, which for an offline-queued record is later).
  @Column({ name: 'wiped_at', type: 'timestamptz', nullable: true })
  wipedAt: Date | null;

  @Column({ name: 'wipe_started_at', type: 'timestamptz', nullable: true })
  wipeStartedAt: Date | null;

  // 'network' | 'unsynced' - whether the station clock behind wiped_at was
  // network-synced at the time.
  @Column({
    name: 'wiped_at_clock',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  wipedAtClock: string | null;

  // Which drive this record is about. Indexed for per-drive lookups; the rest
  // of the drive's identity is in wipedDrive.
  @Column({
    name: 'wiped_drive_serial',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  wipedDriveSerial: string | null;

  @Column({ name: 'wiped_drive', type: 'jsonb', nullable: true })
  wipedDrive: WipedDrive | null;

  // Which code produced the record.
  @Column({ name: 'tool_name', type: 'varchar', length: 64, nullable: true })
  toolName: string | null;

  @Column({ name: 'tool_version', type: 'varchar', length: 64, nullable: true })
  toolVersion: string | null;

  @Column({ name: 'tool_commit', type: 'varchar', length: 64, nullable: true })
  toolCommit: string | null;

  // What was asked for (auto|crypto|secure|overwrite|zero), what was tried in
  // order, and why a stronger method was not used.
  @Column({
    name: 'wipe_method_requested',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  wipeMethodRequested: string | null;

  @Column({
    name: 'wipe_method_attempted',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  wipeMethodAttempted: string | null;

  @Column({
    name: 'wipe_fallback_reason',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  wipeFallbackReason: string | null;

  // 'purge' | 'clear' | 'none' (NIST SP 800-88). CHECK-constrained in the DB.
  @Column({
    name: 'sanitisation_level',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  sanitisationLevel: string | null;

  // Read-back result: 'clean' | 'found' | 'unverified'.
  @Column({
    name: 'wipe_verification',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  wipeVerification: string | null;

  // HPA/DCO outcome: none | hpa-removed | unknown | dco-present | hpa-present.
  @Column({ name: 'hidden_areas', type: 'varchar', length: 32, nullable: true })
  hiddenAreas: string | null;

  // Device-lock roll-up (CLEAR | LOCKED | WARNING | UNVERIFIED), derived by the
  // server from hardware_profile - see lockStatusOf in devices/wipe-detail.ts.
  @Column({ name: 'lock_status', type: 'varchar', length: 16, nullable: true })
  lockStatus: string | null;

  // Human-readable limitations of this wipe. [] = the engine reported none;
  // NULL = not reported (older stick).
  @Column({ name: 'wipe_limitations', type: 'jsonb', nullable: true })
  wipeLimitations: string[] | null;

  @Column({ name: 'wipe_smart', type: 'jsonb', nullable: true })
  wipeSmart: WipeSmart | null;

  @Column({
    name: 'final_disposition',
    type: 'enum',
    enum: FinalDisposition,
    nullable: true,
  })
  finalDisposition: FinalDisposition | null;

  // Which workflow filed this event: 'amazon' (the Audit Station) or
  // 'goods_in' (receiving). NULL = recorded before the kind existed, or by a
  // USB stick that predates it — rendered as "Unclassified", never guessed.
  // varchar, not a pg enum: kiosk-fed vocabularies grow, and an enum turns
  // each new value into a migration. The DTOs validate the values instead.
  @Column({ name: 'audit_kind', type: 'varchar', nullable: true })
  auditKind: string | null;

  // The human at the Audit Station. Free text, not a users FK — the station
  // authenticates as one shared account, so audited_by_id cannot name the
  // operator, and station operators aren't necessarily app users.
  @Column({ name: 'operator_name', type: 'varchar', nullable: true })
  operatorName: string | null;

  // OS restore result ('installed' | 'failed') and which image was used. The
  // kiosk performs installs; before these columns the result was never
  // reported anywhere.
  @Column({ name: 'restore_image_status', type: 'varchar', nullable: true })
  restoreImageStatus: string | null;

  @Column({ name: 'restore_image_name', type: 'varchar', nullable: true })
  restoreImageName: string | null;

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
