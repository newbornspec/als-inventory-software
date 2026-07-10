import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Batch } from './batch.entity';
import { Lot } from './lot.entity';
import { ExpectedLineItem } from './expected-line-item.entity';
import { Asset } from '../assets/asset.entity';
import { BatchesController } from './batches.controller';
import { BatchesService } from './batches.service';
import { LotsController } from './lots.controller';
import { LotsService } from './lots.service';
import { ExpectedLineItemsController } from './expected-line-items.controller';
import { ExpectedLineItemsService } from './expected-line-items.service';

@Module({
  imports: [TypeOrmModule.forFeature([Batch, Lot, ExpectedLineItem, Asset])],
  controllers: [BatchesController, LotsController, ExpectedLineItemsController],
  providers: [BatchesService, LotsService, ExpectedLineItemsService],
})
export class BatchesModule {}
