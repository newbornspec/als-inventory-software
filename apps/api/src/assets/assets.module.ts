import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from './asset.entity';
import { AssetHistory } from './asset-history.entity';
import { AssetAudit } from './asset-audit.entity';
import { Batch } from '../batches/batch.entity';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { BarcodeService } from './barcode.service';
import { CertificatesService } from './certificates.service';

@Module({
  imports: [TypeOrmModule.forFeature([Asset, AssetHistory, AssetAudit, Batch])],
  controllers: [AssetsController],
  providers: [AssetsService, BarcodeService, CertificatesService],
  exports: [AssetsService, CertificatesService],
})
export class AssetsModule {}
