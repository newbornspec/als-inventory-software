import { ArrayUnique, IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { UserRole } from '../user.entity';
import { ALL_PERMISSIONS, Permission } from '../../auth/permissions';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  permissions?: Permission[];
}
