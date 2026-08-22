import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

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

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.users.remove(id, req.user.userId);
  }
}
