import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import type { HardwareProfile } from '../hardware-profile.type';
import { DataWipeStatus } from '../../assets/asset-audit.entity';

// Auto-read specs from the capture tool. No asset tag / no verification — the
// device is created (or re-audited) in the target lot using its serial.
//
// `profile` is the comprehensive, extensible capture (all hardware categories);
// the flat fields below remain for backward compatibility with the simple path
// and are used only as fallbacks when the profile omits them.
export class IngestAuditDto {
  @IsOptional() @IsUUID() lotId?: string; // parent purchase lot; else the operator's active lot
  @IsOptional() @IsUUID() subLotId?: string; // optional sub-lot (spec bucket) within that lot

  // Comprehensive hardware profile — stored verbatim as JSONB. Loosely validated
  // on purpose: the tool may add fields over time without a backend change.
  @IsOptional() @IsObject() profile?: HardwareProfile;

  // --- legacy flat fields (fallbacks) ---
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() cpu?: string;
  @IsOptional() @IsInt() @Min(0) ramGb?: number;
  @IsOptional() @IsString() storageCapacity?: string;
  @IsOptional() @IsString() screenSize?: string;
  @IsOptional() @IsString() screenResolution?: string;
  @IsOptional() @IsString() batteryHealth?: string;
  @IsOptional() @IsBoolean() biosLocked?: boolean;
  @IsOptional() @IsBoolean() chargerIncluded?: boolean;
  @IsOptional() @IsString() notes?: string;

  // Set by the capture tool when it securely erases the machine's drives, so the
  // wipe lands on the audit record (and feeds the erasure certificate).
  @IsOptional() @IsEnum(DataWipeStatus) dataWipeStatus?: DataWipeStatus;
  @IsOptional() @IsString() dataWipeMethod?: string;

  // True when a human entered this via the "Add asset" form rather than the
  // capture tool — only affects the history-note wording (provenance).
  @IsOptional() @IsBoolean() manual?: boolean;
}
