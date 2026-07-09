import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { LotsService } from './lots.service';
import { CreateLotDto } from './dto/create-lot.dto';
import { UpdateLotDto } from './dto/update-lot.dto';

@Controller('lots')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LotsController {
  constructor(private lots: LotsService) {}

  @Get()
  findAll(@Query('batchId') batchId?: string) {
    return this.lots.findAll(batchId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.lots.findOne(id);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Post()
  create(@Body() dto: CreateLotDto) {
    return this.lots.create(dto);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateLotDto) {
    return this.lots.update(id, dto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.lots.remove(id);
  }
}
