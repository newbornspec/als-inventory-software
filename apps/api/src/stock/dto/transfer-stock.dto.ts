import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

// A move, not an adjustment: quantity is always positive and the direction is
// carried by the two locations rather than by a sign. The source is the line in
// the URL; toLocationId is where it is going.
export class TransferStockDto {
  @IsUUID() toLocationId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional() @IsString() note?: string;
}
