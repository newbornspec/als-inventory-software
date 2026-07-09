import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { BatchesService } from './batches.service';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';

@Controller('batches')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BatchesController {
  constructor(private batches: BatchesService) {}

  // Any role can view — technicians select an open batch to receive against
  // on the scan page, same reasoning as asset read access.
  @Get()
  findAll() {
    return this.batches.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.batches.findOne(id);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Post()
  create(@Body() dto: CreateBatchDto, @Req() req: any) {
    return this.batches.create(dto, req.user.userId);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateBatchDto) {
    return this.batches.update(id, dto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.batches.remove(id);
  }
}
