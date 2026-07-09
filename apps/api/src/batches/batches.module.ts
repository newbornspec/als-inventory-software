import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Batch } from './batch.entity';
import { Lot } from './lot.entity';
import { Asset } from '../assets/asset.entity';
import { BatchesController } from './batches.controller';
import { BatchesService } from './batches.service';
import { LotsController } from './lots.controller';
import { LotsService } from './lots.service';

@Module({
  imports: [TypeOrmModule.forFeature([Batch, Lot, Asset])],
  controllers: [BatchesController, LotsController],
  providers: [BatchesService, LotsService],
})
export class BatchesModule {}
