import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { AssetAuditStatus, AssetConditionGrade, AssetStockStatus } from '../asset.entity';

export class CreateAssetDto {
  @IsString()
  tag: string;

  @IsString()
  name: string;

  @IsString()
  category: string;

  @IsOptional()
  @IsEnum(AssetStockStatus)
  stockStatus?: AssetStockStatus;

  @IsOptional()
  @IsEnum(AssetConditionGrade)
  conditionGrade?: AssetConditionGrade;

  @IsOptional()
  @IsEnum(AssetAuditStatus)
  auditStatus?: AssetAuditStatus;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsDateString()
  warrantyExpiresAt?: string;

  // Optional manual per-unit cost override (else even split of the lot cost).
  @IsOptional()
  @IsNumber()
  @Min(0)
  purchaseCost?: number;

  @IsOptional()
  @IsUUID()
  batchId?: string;

  @IsOptional()
  @IsUUID()
  lotId?: string;
}
