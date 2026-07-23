import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

// One row of Layout 2's specification table — a hardware spec group + how many
// machines share it. Each field is optional; the row becomes a Product + a
// pallet line.
export class SpecRowDto {
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() chassis?: string;
  @IsOptional() @IsString() cpu?: string;
  @IsOptional() @IsString() ram?: string;
  @IsOptional() @IsString() storage?: string;

  @IsInt() @Min(0) quantity: number;
}

// Layout 2 create: pallet metadata + the spec rows, in one request.
export class CreatePalletSpecDto {
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() supplier?: string;
  @IsOptional() @IsString() buyer?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsString() notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SpecRowDto)
  rows: SpecRowDto[];
}
