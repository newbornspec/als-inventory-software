import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreatePalletLineDto {
  @IsString() variant: string;

  @IsInt()
  @Min(0)
  quantity: number;

  @IsOptional() @IsUUID() productId?: string;
}
