import { IsString, MinLength } from 'class-validator';

// Same 8-character floor as CreateUserDto, so a password set at creation and
// one set by a reset are held to one rule. No "current password" field: an
// admin cannot know it, and this exists precisely for the case where the user
// cannot sign in at all.
export class ResetPasswordDto {
  @IsString()
  @MinLength(8)
  password: string;
}
