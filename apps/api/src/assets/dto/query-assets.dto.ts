import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { AssetAuditStatus, AssetConditionGrade, AssetStockStatus } from '../asset.entity';

export class QueryAssetsDto {
  @IsOptional()
  @IsString()
  search?: string; // matches against tag or name

  @IsOptional()
  @IsString()
  category?: string;

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
  batchId?: string;

  @IsOptional()
  @IsUUID()
  lotId?: string;
}
