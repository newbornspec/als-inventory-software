import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateStockLineDto {
  @IsString() name: string;

  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() locationId?: string;

  // Opening quantity — recorded as an initial 'received' movement if > 0.
  @IsOptional() @IsInt() @Min(0) quantity?: number;

  @IsOptional() @IsString() notes?: string;
}
