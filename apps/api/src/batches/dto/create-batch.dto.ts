import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { BatchStatus } from '../batch.entity';

export class CreateBatchDto {
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsDateString() receivedDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedUnitCount?: number;

  @IsOptional()
  @IsEnum(BatchStatus)
  status?: BatchStatus;

  @IsOptional() @IsString() notes?: string;
}
