import { IsEnum, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';
import { ProductTrackingType } from '../product.entity';

export class CreateProductDto {
  @IsString() name: string;

  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() category?: string;

  @IsOptional()
  @IsEnum(ProductTrackingType)
  trackingType?: ProductTrackingType;

  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() cpu?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  ramGb?: number;

  @IsOptional() @IsString() storage?: string;
  @IsOptional() @IsString() screenSize?: string;

  @IsOptional() @IsObject() attributes?: Record<string, unknown>;
}
