import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { AssetConditionGrade } from '../../assets/asset.entity';

// The two fixed Layout 1 lists. Kept here as a const rather than a DB enum
// because they are two values that the business has not asked to configure —
// unlike manufacturer/model/size, which are admin-managed lookup values.
export const PALLET_VARIANT_TYPES = ['normal', 'frameless'] as const;

export class CreatePalletLineDto {
  // Optional: Layout 1 composes this server-side from the spec fields below.
  // Still accepted so the older client, and Layout 2, keep working unchanged.
  @IsOptional() @IsString() variant?: string;

  @IsOptional() @IsString() @MaxLength(120) manufacturer?: string;

  @IsOptional() @IsString() @MaxLength(120) model?: string;

  @IsOptional() @IsString() @MaxLength(40) size?: string;

  @IsOptional() @IsIn(PALLET_VARIANT_TYPES as unknown as string[]) variantType?: string;

  @IsOptional() @IsBoolean() stand?: boolean;

  @IsOptional() @IsIn(['tier_1', 'tier_2']) tier?: string;

  @IsInt()
  @Min(0)
  quantity: number;

  // Deliberately the full enum, not just A-D. Layout 1 only OFFERS A-D, but
  // rows created earlier may hold for_parts or scrap and must stay patchable.
  @IsOptional() @IsEnum(AssetConditionGrade) grade?: AssetConditionGrade;

  // Optional — a line saves fine without it.
  @IsOptional() @IsNumber() @Min(0) unitCost?: number;

  @IsOptional() @IsUUID() productId?: string;
}
