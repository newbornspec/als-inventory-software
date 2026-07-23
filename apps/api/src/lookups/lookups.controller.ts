import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { LookupsService } from './lookups.service';
import { CreateLookupDto } from './dto/create-lookup.dto';
import { UpdateLookupDto } from './dto/update-lookup.dto';
import { QueryLookupsDto } from './dto/query-lookups.dto';

@Controller('lookups')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LookupsController {
  constructor(private lookups: LookupsService) {}

  // Any authed role reads the dropdown values (needed while creating pallets).
  @Get()
  findAll(@Query() query: QueryLookupsDto) {
    return this.lookups.findAll(query);
  }

  // Creating a value happens when a user types a new one during data entry, so
  // anyone who can input data may add — same roles that can create a pallet.
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN)
  @Post()
  create(@Body() dto: CreateLookupDto) {
    return this.lookups.create(dto);
  }

  // Curating the master list (rename, enable/disable, reorder, delete) is admin.
  @Roles(UserRole.ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateLookupDto) {
    return this.lookups.update(id, dto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.lookups.remove(id);
  }
}
