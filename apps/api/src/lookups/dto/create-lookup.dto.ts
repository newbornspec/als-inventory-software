import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { LOOKUP_CATEGORIES } from '../lookup-value.entity';

export class CreateLookupDto {
  @IsIn(LOOKUP_CATEGORIES as unknown as string[])
  category: string;

  @IsString()
  @MinLength(1)
  value: string;

  // Required for dependent categories (a 'model' needs its 'manufacturer').
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
