import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '../assets/asset.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import { AssetAudit } from '../assets/asset-audit.entity';
import { Batch } from '../batches/batch.entity';
import { PowerSyncController } from './powersync.controller';
import { PowerSyncService } from './powersync.service';

@Module({
  imports: [TypeOrmModule.forFeature([Asset, AssetHistory, AssetAudit, Batch])],
  controllers: [PowerSyncController],
  providers: [PowerSyncService],
})
export class PowerSyncModule {}
