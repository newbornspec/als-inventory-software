import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';

@Controller('products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProductsController {
  constructor(private products: ProductsService) {}

  // Readable with any of goods_in/assets/pallets — technicians pick a product's
  // spec when building a sub-lot on the scan page, same reasoning as asset/batch reads.
  @RequirePermissions('goods_in', 'assets', 'pallets')
  @Get()
  findAll(@Query() query: QueryProductsDto) {
    return this.products.findAll(query);
  }

  @RequirePermissions('goods_in', 'assets', 'pallets')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.products.findOne(id);
  }

  @RequirePermissions('manage_products')
  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @RequirePermissions('manage_products')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  @RequirePermissions('delete_product')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.products.remove(id);
  }
}
