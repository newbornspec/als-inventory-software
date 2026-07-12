import { PartialType } from '@nestjs/mapped-types';
import { CreateRepairDto } from './create-repair.dto';

export class UpdateRepairDto extends PartialType(CreateRepairDto) {}
