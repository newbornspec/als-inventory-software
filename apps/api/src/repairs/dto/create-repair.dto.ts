import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { RepairStatus } from '../repair-log.entity';

export class CreateRepairDto {
  @IsString() description: string;

  @IsOptional() @IsString() partsUsed?: string;

  // Optional — a job saves without a cost.
  @IsOptional() @IsNumber() @Min(0) cost?: number;

  @IsOptional() @IsEnum(RepairStatus) status?: RepairStatus;
}
