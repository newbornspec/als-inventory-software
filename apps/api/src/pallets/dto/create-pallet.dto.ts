import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { PalletStatus } from '../pallet.entity';

export class CreatePalletDto {
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() supplier?: string;
  @IsOptional() @IsString() buyer?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsEnum(PalletStatus) status?: PalletStatus;
  @IsOptional() @IsString() notes?: string;
}
