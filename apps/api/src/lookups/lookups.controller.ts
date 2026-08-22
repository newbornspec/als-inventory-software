import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AnyAuthenticated, RequirePermissions } from '../auth/guards/permissions.decorator';
import { LookupsService } from './lookups.service';
import { CreateLookupDto } from './dto/create-lookup.dto';
import { UpdateLookupDto } from './dto/update-lookup.dto';
import { QueryLookupsDto } from './dto/query-lookups.dto';

@Controller('lookups')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LookupsController {
  constructor(private lookups: LookupsService) {}

  // Any authed user reads the dropdown values (needed while creating pallets).
  @AnyAuthenticated()
  @Get()
  findAll(@Query() query: QueryLookupsDto) {
    return this.lookups.findAll(query);
  }

  // Creating a value happens when a user types a new one during data entry, so
  // anyone who can input data may add — gated by 'add_lookup_values'.
  @RequirePermissions('add_lookup_values')
  @Post()
  create(@Body() dto: CreateLookupDto) {
    return this.lookups.create(dto);
  }

  // Curating the master list (rename, enable/disable, reorder, delete) requires
  // 'manage_lookups'.
  @RequirePermissions('manage_lookups')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateLookupDto) {
    return this.lookups.update(id, dto);
  }

  @RequirePermissions('manage_lookups')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.lookups.remove(id);
  }
}
