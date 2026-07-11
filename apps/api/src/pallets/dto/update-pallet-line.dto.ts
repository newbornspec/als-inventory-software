import { PartialType } from '@nestjs/mapped-types';
import { CreatePalletLineDto } from './create-pallet-line.dto';

export class UpdatePalletLineDto extends PartialType(CreatePalletLineDto) {}
