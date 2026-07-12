import { IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { AssetConditionGrade } from '../../assets/asset.entity';

export class CreatePalletLineDto {
  @IsString() variant: string;

  @IsOptional() @IsString() supplier?: string;

  @IsInt()
  @Min(0)
  quantity: number;

  @IsOptional() @IsEnum(AssetConditionGrade) grade?: AssetConditionGrade;

  // Optional — a line saves fine without it.
  @IsOptional() @IsNumber() @Min(0) unitCost?: number;

  @IsOptional() @IsUUID() productId?: string;
}
