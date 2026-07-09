import { IsDateString, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
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

  @IsOptional()
  @IsUUID()
  batchId?: string;

  @IsOptional()
  @IsUUID()
  lotId?: string;
}
