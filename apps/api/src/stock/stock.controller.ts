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
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { StockService } from './stock.service';
import { CreateStockLineDto } from './dto/create-stock-line.dto';
import { UpdateStockLineDto } from './dto/update-stock-line.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { TransferStockDto } from './dto/transfer-stock.dto';

@Controller('stock')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StockController {
  constructor(private stock: StockService) {}

  @RequirePermissions('consumables')
  @Get()
  findAll(@Query('search') search?: string) {
    return this.stock.findAll(search);
  }

  @RequirePermissions('consumables')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.stock.findOne(id);
  }

  @RequirePermissions('manage_consumables')
  @Post()
  create(@Body() dto: CreateStockLineDto, @Req() req: any) {
    return this.stock.create(dto, req.user.userId);
  }

  @RequirePermissions('manage_consumables')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateStockLineDto) {
    return this.stock.update(id, dto);
  }

  @RequirePermissions('manage_consumables')
  @Post(':id/adjust')
  adjust(@Param('id') id: string, @Body() dto: AdjustStockDto, @Req() req: any) {
    return this.stock.adjust(id, dto, req.user.userId);
  }

  // Same gate as adjust — moving stock changes what two locations hold.
  @RequirePermissions('manage_consumables')
  @Post(':id/transfer')
  transfer(@Param('id') id: string, @Body() dto: TransferStockDto, @Req() req: any) {
    return this.stock.transfer(id, dto, req.user.userId);
  }

  @RequirePermissions('delete_consumable')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.stock.remove(id);
  }
}
