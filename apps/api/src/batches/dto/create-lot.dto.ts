import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { LotStatus } from '../lot.entity';

export class CreateLotDto {
  @IsOptional() @IsUUID() batchId?: string;
  @IsOptional() @IsString() description?: string;

  // Declared spec for this sub-lot (the spec bucket's identity).
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() cpu?: string;
  @IsOptional() @IsInt() @Min(0) ramGb?: number;
  @IsOptional() @IsString() storage?: string;
  @IsOptional() @IsString() screenSize?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  expectedUnitCount?: number;

  @IsOptional()
  @IsEnum(LotStatus)
  status?: LotStatus;

  @IsOptional() @IsString() notes?: string;
}
