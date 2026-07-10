import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ProductTrackingType } from '../product.entity';

export class QueryProductsDto {
  // Free-text match over name / sku / model.
  @IsOptional() @IsString() search?: string;

  @IsOptional()
  @IsEnum(ProductTrackingType)
  trackingType?: ProductTrackingType;

  @IsOptional() @IsString() category?: string;
}
