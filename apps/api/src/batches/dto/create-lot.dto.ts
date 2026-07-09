import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { LotStatus } from '../lot.entity';

export class CreateLotDto {
  @IsOptional() @IsUUID() batchId?: string;
  @IsOptional() @IsString() description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedUnitCount?: number;

  @IsOptional()
  @IsEnum(LotStatus)
  status?: LotStatus;

  @IsOptional() @IsString() notes?: string;
}
