import {
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
  // Two or more. The workspace selects pallets with checkboxes, so merging
  // three in one go is a natural thing to ask for and refusing it would be an
  // arbitrary dead end.
  @IsArray()
  @ArrayMinSize(2)
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
