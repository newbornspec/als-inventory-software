import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SetUserDisabledDto } from './dto/set-user-disabled.dto';

// The 'users' module permission gates all of user management — seeing
// accounts, creating them, and editing what they're allowed to do. Only
// admins hold it by default, but unlike the old @Roles(ADMIN), an admin can
// now delegate it deliberately.
@Controller('users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('users')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  findAll() {
    return this.users.findAll();
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  // Separate route rather than a field on PATCH :id, because update() resets
  // permissions to the role baseline whenever a role arrives without explicit
  // grants — disabling must never be able to trigger that as a side effect.
  @Patch(':id/disabled')
  setDisabled(
    @Param('id') id: string,
    @Body() dto: SetUserDisabledDto,
    @Req() req: any,
  ) {
    return this.users.setDisabled(id, dto.disabled, req.user.userId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.users.remove(id, req.user.userId);
  }
}
