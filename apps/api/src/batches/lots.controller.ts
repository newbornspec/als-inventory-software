import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
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
  findAll(@Req() req: any, @Query('batchId') batchId?: string) {
    return this.lots.findAll(batchId, req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.lots.findOne(id, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Post()
  create(@Body() dto: CreateLotDto, @Req() req: any) {
    return this.lots.create(dto, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateLotDto, @Req() req: any) {
    return this.lots.update(id, dto, req.user);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.lots.remove(id);
  }
}
