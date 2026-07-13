import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

// Auto-read specs from the capture tool. No asset tag / no verification — the
// device is created (or re-audited) in the target lot using its serial.
export class IngestAuditDto {
  @IsOptional() @IsUUID() lotId?: string; // else the operator's active lot
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
}
