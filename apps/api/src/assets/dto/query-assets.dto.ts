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

  // 'true' → only assets not assigned to any lot/batch (the "No lot" bucket on
  // the grouped Assets page). Kept as a string flag since batchId must be a UUID.
  @IsOptional()
  @IsString()
  noBatch?: string;

  // 'true' → only assets with no location set. Same string-flag reason as
  // noBatch: locationId must be a UUID, so "is null" needs its own parameter.
  // The dashboard's "No location set" row links here.
  @IsOptional()
  @IsString()
  noLocation?: string;

  // 'true' → only assets that have never been audited (audit_status IS NULL).
  // This is what the app means by "awaiting audit": the stock status of the
  // same name is a hand-picked dropdown value that production code never sets,
  // so counting it would report ~0 however much work is outstanding.
  @IsOptional()
  @IsString()
  noAudit?: string;

  @IsOptional()
  @IsUUID()
  lotId?: string;
}
