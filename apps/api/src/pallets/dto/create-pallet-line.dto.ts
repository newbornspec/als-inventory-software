import { IsInt, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreatePalletLineDto {
  @IsString() variant: string;

  @IsOptional() @IsString() supplier?: string;

  @IsInt()
  @Min(0)
  quantity: number;

  // Optional — a line saves fine without it.
  @IsOptional() @IsNumber() @Min(0) unitCost?: number;

  @IsOptional() @IsUUID() productId?: string;
}
