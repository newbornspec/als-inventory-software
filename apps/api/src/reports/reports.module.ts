import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '../assets/asset.entity';
import { Batch } from '../batches/batch.entity';
import { OrderLine } from '../sales/order-line.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [TypeOrmModule.forFeature([Asset, Batch, OrderLine])],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
