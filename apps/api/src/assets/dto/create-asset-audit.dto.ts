import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString } from 'class-validator';
import { AssetAuditStatus, AssetConditionGrade } from '../asset.entity';
import { DataWipeStatus, FinalDisposition } from '../asset-audit.entity';
import type { FunctionalTestResults } from '../asset-audit.entity';

export class CreateAssetAuditDto {
  // The technician's overall call for this audit — directly sets
  // Asset.auditStatus. Not inferred from the other fields below, since
  // e.g. a wiped drive doesn't necessarily mean the unit passed testing.
  @IsOptional()
  @IsEnum(AssetAuditStatus)
  auditStatus?: AssetAuditStatus;

  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsString() cpu?: string;
  @IsOptional() @IsInt() ramGb?: number;
  @IsOptional() @IsString() storageCapacity?: string;
  @IsOptional() @IsString() screenSize?: string;
  @IsOptional() @IsString() screenResolution?: string;
  @IsOptional() @IsString() batteryHealth?: string;

  @IsOptional()
  @IsEnum(AssetConditionGrade)
  cosmeticGrade?: AssetConditionGrade;

  @IsOptional()
  @IsObject()
  functionalTests?: FunctionalTestResults;

  @IsOptional() @IsBoolean() biosLocked?: boolean;
  @IsOptional() @IsBoolean() chargerIncluded?: boolean;

  @IsOptional()
  @IsEnum(DataWipeStatus)
  dataWipeStatus?: DataWipeStatus;

  @IsOptional() @IsString() dataWipeMethod?: string;

  @IsOptional()
  @IsEnum(FinalDisposition)
  finalDisposition?: FinalDisposition;

  @IsOptional() @IsString() notes?: string;
}
