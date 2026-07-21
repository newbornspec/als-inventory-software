import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { AssetConditionGrade } from '../../assets/asset.entity';

export class CreatePalletLineDto {
  @IsString() variant: string;

  @IsOptional() @IsString() buyer?: string;

  @IsOptional() @IsIn(['tier_1', 'tier_2']) tier?: string;

  @IsInt()
  @Min(0)
  quantity: number;

  @IsOptional() @IsEnum(AssetConditionGrade) grade?: AssetConditionGrade;

  // Optional — a line saves fine without it.
  @IsOptional() @IsNumber() @Min(0) unitCost?: number;

  @IsOptional() @IsUUID() productId?: string;
}
