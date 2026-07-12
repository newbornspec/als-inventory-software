import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SalesOrder } from './sales-order.entity';
import { OrderLine } from './order-line.entity';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [TypeOrmModule.forFeature([SalesOrder, OrderLine])],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
