import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { StockService } from './stock.service';
import { CreateStockLineDto } from './dto/create-stock-line.dto';
import { UpdateStockLineDto } from './dto/update-stock-line.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';

@Controller('stock')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StockController {
  constructor(private stock: StockService) {}

  @Get()
  findAll(@Query('search') search?: string) {
    return this.stock.findAll(search);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.stock.findOne(id);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Post()
  create(@Body() dto: CreateStockLineDto, @Req() req: any) {
    return this.stock.create(dto, req.user.userId);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStockLineDto) {
    return this.stock.update(id, dto);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Post(':id/adjust')
  adjust(@Param('id') id: string, @Body() dto: AdjustStockDto, @Req() req: any) {
    return this.stock.adjust(id, dto, req.user.userId);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.stock.remove(id);
  }
}
