import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { BatchStatus } from '../batch.entity';

export class CreateBatchDto {
  @IsOptional() @IsString() source?: string; // supplier the lot was purchased from
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsDateString() receivedDate?: string;

  // Pre-arrival purchasing details — set when a lot is created before it lands.
  @IsOptional() @IsString() purchaseOrder?: string;
  @IsOptional() @IsString() deliveryNote?: string;
  @IsOptional() @IsDateString() purchaseDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedUnitCount?: number;

  @IsOptional()
  @IsEnum(BatchStatus)
  status?: BatchStatus;

  // What the whole lot cost — the basis for per-unit allocation and profit.
  @IsOptional() @IsNumber() @Min(0) totalCost?: number;

  @IsOptional() @IsString() notes?: string;
}
