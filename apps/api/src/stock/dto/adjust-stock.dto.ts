import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { StockMovementReason } from '../stock-movement.entity';

export class AdjustStockDto {
  // Signed: positive to add stock, negative to remove.
  @IsInt() delta: number;

  @IsEnum(StockMovementReason) reason: StockMovementReason;

  @IsOptional() @IsString() note?: string;
}
