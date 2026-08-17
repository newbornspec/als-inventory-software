import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  Matches,
  MaxLength,
  MinLength,
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
  @IsOptional() @IsString() gen?: string;
  @IsOptional() @IsString() ram?: string;
  @IsOptional() @IsString() storage?: string;

  @IsInt() @Min(0) quantity: number;
}

// Layout 2 create/save: pallet metadata + the spec rows, in one request. Rows
// are optional so picking Layout 2 can create the pallet immediately (empty
// grid) and the editor can fill it in afterwards.
export class CreatePalletSpecDto {
  // Same operator-entered number as Layout 1. Layout 2 usually creates its
  // pallet before there is anywhere to type one, so blank falls back to the
  // sequence. See CreatePalletDto for why the character class is here.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, {
    message: 'Pallet number may use letters, numbers, spaces and . _ / -',
  })
  palletNumber?: string;

  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() supplier?: string;
  @IsOptional() @IsString() buyer?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsString() notes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SpecRowDto)
  rows?: SpecRowDto[];
}
