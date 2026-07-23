import { IsBoolean, IsInt, IsOptional, IsString, MinLength } from 'class-validator';

// Admin edits: rename, enable/disable, reorder. Category/parent are fixed once
// created (changing them would orphan dependent rows or existing references).
export class UpdateLookupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  value?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
