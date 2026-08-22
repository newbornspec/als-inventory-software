import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Pallet } from './pallet.entity';
import { PalletLine } from './pallet-line.entity';
import { PalletSoldLine } from './pallet-sold-line.entity';
import { PalletMerge } from './pallet-merge.entity';
import { Product } from '../products/product.entity';
import { Asset } from '../assets/asset.entity';
import { AssetHistory } from '../assets/asset-history.entity';
import { Batch } from '../batches/batch.entity';
import { PalletsController } from './pallets.controller';
import { PalletsService } from './pallets.service';
import { LookupsModule } from '../lookups/lookups.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Pallet, PalletLine, PalletSoldLine, PalletMerge, Product,
      // Goods In allocation: asset pallets hold devices, log history, and
      // enforce lot ownership — hence these three.
      Asset, AssetHistory, Batch,
    ]),
    LookupsModule,
    // ActivityService is injected by the merge but not imported here —
    // ActivityModule is @Global, which is how every other module reaches it.
  ],
  controllers: [PalletsController],
  providers: [PalletsService],
  // Exported so InvoicesModule can snapshot a pallet's lines onto an invoice.
  exports: [PalletsService],
})
export class PalletsModule {}
