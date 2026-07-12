import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { RepairsService } from './repairs.service';
import { CreateRepairDto } from './dto/create-repair.dto';
import { UpdateRepairDto } from './dto/update-repair.dto';

// Recording repair work is field/bench work any authenticated role does, like
// audits — only deletion is restricted to admin/manager.
@Controller('assets/:assetId/repairs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RepairsController {
  constructor(private repairs: RepairsService) {}

  @Get()
  findForAsset(@Param('assetId') assetId: string) {
    return this.repairs.findForAsset(assetId);
  }

  @Post()
  create(@Param('assetId') assetId: string, @Body() dto: CreateRepairDto, @Req() req: any) {
    return this.repairs.create(assetId, dto, req.user.userId);
  }

  @Patch(':id')
  update(
    @Param('assetId') assetId: string,
    @Param('id') id: string,
    @Body() dto: UpdateRepairDto,
  ) {
    return this.repairs.update(assetId, id, dto);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Delete(':id')
  remove(@Param('assetId') assetId: string, @Param('id') id: string) {
    return this.repairs.remove(assetId, id);
  }
}
