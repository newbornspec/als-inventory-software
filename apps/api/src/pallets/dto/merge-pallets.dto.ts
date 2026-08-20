import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class MergePalletsDto {
  // Exactly two. A merge cannot be undone, and the confirmation dialog states
  // both pallet numbers and the combined unit total — a sentence the operator
  // can actually check. A variable-N merge has no equivalent.
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  palletIds!: string[];

  // Optional: the warehouse may already have written a number on the physical
  // pallet the stock is being stacked onto. Blank falls back to the sequence,
  // the same rule as creating a pallet.
  //
  // The character class is not cosmetic — the pallet number is interpolated
  // into a Content-Disposition header by the xlsx export.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, {
    message: 'Pallet number may use letters, numbers, spaces and . _ / -',
  })
  palletNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}
