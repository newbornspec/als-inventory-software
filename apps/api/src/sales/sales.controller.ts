import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { SalesService } from './sales.service';
import { CreateSalesOrderDto } from './dto/create-sales-order.dto';
import { UpdateSalesOrderDto } from './dto/update-sales-order.dto';
import { CreateOrderLineDto } from './dto/create-order-line.dto';
import { UpdateOrderLineDto } from './dto/update-order-line.dto';

@Controller('orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SalesController {
  constructor(private sales: SalesService) {}

  @RequirePermissions('sold')
  @Get()
  findAll() {
    return this.sales.findAll();
  }

  @RequirePermissions('sold')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.sales.findOne(id);
  }

  @RequirePermissions('sold')
  @Post()
  create(@Body() dto: CreateSalesOrderDto) {
    return this.sales.create(dto);
  }

  @RequirePermissions('sold')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSalesOrderDto) {
    return this.sales.update(id, dto);
  }

  @RequirePermissions('manage_sales')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.sales.remove(id);
  }

  // --- lines ---

  @RequirePermissions('sold')
  @Post(':id/lines')
  addLine(@Param('id') id: string, @Body() dto: CreateOrderLineDto) {
    return this.sales.addLine(id, dto);
  }

  @RequirePermissions('sold')
  @Patch(':id/lines/:lineId')
  updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdateOrderLineDto,
  ) {
    return this.sales.updateLine(id, lineId, dto);
  }

  @RequirePermissions('manage_sales')
  @Delete(':id/lines/:lineId')
  removeLine(@Param('id') id: string, @Param('lineId') lineId: string) {
    return this.sales.removeLine(id, lineId);
  }
}
