import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { LotsService } from './lots.service';
import { CreateLotDto } from './dto/create-lot.dto';
import { UpdateLotDto } from './dto/update-lot.dto';

@Controller('lots')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LotsController {
  constructor(private lots: LotsService) {}

  @RequirePermissions('goods_in', 'assets')
  @Get()
  findAll(@Req() req: any, @Query('batchId') batchId?: string) {
    return this.lots.findAll(batchId, req.user);
  }

  @RequirePermissions('goods_in', 'assets')
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.lots.findOne(id, req.user);
  }

  @RequirePermissions('edit_batch')
  @Post()
  create(@Body() dto: CreateLotDto, @Req() req: any) {
    return this.lots.create(dto, req.user);
  }

  @RequirePermissions('edit_batch')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateLotDto, @Req() req: any) {
    return this.lots.update(id, dto, req.user);
  }

  @RequirePermissions('delete_batch')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.lots.remove(id);
  }
}
