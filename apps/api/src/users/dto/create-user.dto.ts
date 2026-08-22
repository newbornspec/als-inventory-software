import { ArrayUnique, IsEmail, IsEnum, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { UserRole } from '../user.entity';
import { ALL_PERMISSIONS, Permission } from '../../auth/permissions';

export class CreateUserDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsEnum(UserRole)
  role: UserRole;

  // Omitted -> the role's default set (auth/permissions.ts). @IsIn against the
  // catalog so a typo'd slug is a 400 here, not a grant that silently never
  // matches anything in the guard.
  @IsOptional()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  permissions?: Permission[];
}
