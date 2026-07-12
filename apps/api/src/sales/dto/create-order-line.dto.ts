import { IsInt, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

// A line is either a serialized asset (assetId) or a free-text description with
// a quantity. Both may carry a unit price.
export class CreateOrderLineDto {
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() assetId?: string;

  // A scanned/typed serial. The server resolves it to a specific asset, so the
  // caller doesn't need to know the asset's UUID — it just sends the barcode value.
  @IsOptional() @IsString() assetTag?: string;

  @IsOptional() @IsInt() @Min(1) quantity?: number;

  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
}
