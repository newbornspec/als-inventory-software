import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { PalletsService } from './pallets.service';
import { CreatePalletDto } from './dto/create-pallet.dto';
import { CreatePalletSpecDto } from './dto/create-pallet-spec.dto';
import { UpdatePalletDto } from './dto/update-pallet.dto';
import { CreatePalletLineDto } from './dto/create-pallet-line.dto';
import { UpdatePalletLineDto } from './dto/update-pallet-line.dto';

@Controller('pallets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PalletsController {
  constructor(private pallets: PalletsService) {}

  @Get()
  findAll() {
    return this.pallets.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.pallets.findOne(id);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get(':id/report.xlsx')
  async report(@Param('id') id: string): Promise<StreamableFile> {
    const { buffer, filename } = await this.pallets.generateReport(id);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN)
  @Post()
  create(@Body() dto: CreatePalletDto) {
    return this.pallets.create(dto);
  }

  // Layout 2 (spec table): create a pallet and all its lines from spec rows.
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN)
  @Post('spec')
  createFromSpec(@Body() dto: CreatePalletSpecDto) {
    return this.pallets.createFromSpec(dto);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePalletDto) {
    return this.pallets.update(id, dto);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.pallets.remove(id);
  }

  // --- lines ---

  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN)
  @Post(':id/lines')
  addLine(@Param('id') id: string, @Body() dto: CreatePalletLineDto) {
    return this.pallets.addLine(id, dto);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN)
  @Patch(':id/lines/:lineId')
  updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdatePalletLineDto,
  ) {
    return this.pallets.updateLine(id, lineId, dto);
  }

  // Removing a mistyped line is content-correction (input), not deleting the
  // whole pallet — technicians may do it. Whole-pallet delete stays admin-only.
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN)
  @Delete(':id/lines/:lineId')
  removeLine(@Param('id') id: string, @Param('lineId') lineId: string) {
    return this.pallets.removeLine(id, lineId);
  }
}
