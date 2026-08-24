import { IsEnum, IsOptional, IsString, IsUUID, IsIn } from 'class-validator';
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

  // 'true' → devices on the shelf and free to allocate: the AVAILABLE set in
  // assets/stock-status.ts, which is what the dashboard's "In stock" tile
  // counts. It needs its own flag because stockStatus matches a single value
  // and this is a set of five — and because filtering on 'in_stock' alone
  // finds almost nothing: the column defaults to 'received' and the audit
  // ingest writes 'audited'.
  @IsOptional()
  @IsIn(['true'])
  available?: string;

  // 'true' → devices still physically held: anything not sold, shipped or
  // disposed. Broader than `available`, which also excludes quarantined and
  // committed stock — a quarantined device is still in the building. The
  // /inventory roll-up counts this set.
  @IsOptional()
  @IsIn(['true'])
  held?: string;

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

  // 'false' = the Goods In pool view (not yet allocated to a pallet);
  // 'true' = only palletised devices. Absent = both, the full register.
  @IsOptional()
  @IsIn(['true', 'false'])
  onPallet?: string;

  // Only devices allocated to this specific pallet. Additive (the register
  // redesign introduced it); onPallet remains the boolean form.
  @IsOptional()
  @IsUUID()
  palletId?: string;

  // The register's lifecycle tab. A derived state, not a stored column: see
  // LIFECYCLE_PREDICATES in assets.service.ts for the one definition both the
  // filter and the status pill follow. 'all' includes sold devices; every
  // other value except 'sold' excludes them.
  @IsOptional()
  @IsIn(['all', 'in_processing', 'audited', 'wiped', 'ready', 'sold', 'quarantine'])
  lifecycle?: string;

  // 'true' → devices with no serial recorded. Same string-flag reason as
  // noBatch: it is an "is null" question, not a value to match.
  @IsOptional()
  @IsString()
  noSerial?: string;
}
