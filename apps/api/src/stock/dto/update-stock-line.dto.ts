import { IsOptional, IsString, IsUUID } from 'class-validator';

// Metadata only — quantity changes go through /stock/:id/adjust so every change
// is logged as a movement.
export class UpdateStockLineDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsString() notes?: string;
}
