import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity';
import { Batch } from '../batches/batch.entity';
import { Asset } from '../assets/asset.entity';
import { AssetAudit } from '../assets/asset-audit.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, Batch, Asset, AssetAudit, AssetHistory])],
  controllers: [DevicesController],
  providers: [DevicesService],
})
export class DevicesModule {}
