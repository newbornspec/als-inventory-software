import { PartialType } from '@nestjs/mapped-types';
import { CreatePalletDto } from './create-pallet.dto';

export class UpdatePalletDto extends PartialType(CreatePalletDto) {}
