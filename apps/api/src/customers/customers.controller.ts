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
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Controller('customers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CustomersController {
  constructor(private customers: CustomersService) {}

  @RequirePermissions('sold')
  @Get()
  findAll(@Query('search') search?: string) {
    return this.customers.findAll(search);
  }

  @RequirePermissions('sold')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customers.findOne(id);
  }

  @RequirePermissions('sold')
  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto);
  }

  @RequirePermissions('sold')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(id, dto);
  }

  @RequirePermissions('manage_sales')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.customers.remove(id);
  }
}
