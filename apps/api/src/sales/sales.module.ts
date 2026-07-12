import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SalesOrder } from './sales-order.entity';
import { OrderLine } from './order-line.entity';
import { Asset } from '../assets/asset.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [TypeOrmModule.forFeature([SalesOrder, OrderLine, Asset, AssetHistory])],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
