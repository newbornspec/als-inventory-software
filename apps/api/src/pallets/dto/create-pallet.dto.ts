import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PalletStatus } from '../pallet.entity';

export class CreatePalletDto {
  // Operator-entered. The warehouse writes a number on the physical pallet
  // before it reaches a keyboard, so the system accepts that number instead of
  // inventing a competing one. Blank falls back to the sequence.
  // The character class is defence in depth for the export filename, which ends
  // up in an HTTP Content-Disposition header (see safeFilePart in the service).
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
  @IsOptional() @IsEnum(PalletStatus) status?: PalletStatus;
  @IsOptional() @IsString() notes?: string;

  // 'asset' creates a device-holding pallet (the Move to Pallet destination).
  // 'spec' is NOT accepted here — Layout 2 pallets come in through POST
  // /pallets/spec, which also writes their grid.
  @IsOptional() @IsIn(['variant', 'asset']) entryLayout?: string;
}
