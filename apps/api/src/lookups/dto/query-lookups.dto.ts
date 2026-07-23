import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { LOOKUP_CATEGORIES } from '../lookup-value.entity';

export class QueryLookupsDto {
  @IsOptional()
  @IsIn(LOOKUP_CATEGORIES as unknown as string[])
  category?: string;

  // Scope dependent lists (e.g. models for a given manufacturer lookup id).
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  // Admin management view wants disabled values too ("true").
  @IsOptional()
  @IsString()
  includeInactive?: string;
}
