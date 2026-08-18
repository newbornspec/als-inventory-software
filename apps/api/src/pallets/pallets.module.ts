import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Pallet } from './pallet.entity';
import { PalletLine } from './pallet-line.entity';
import { PalletSoldLine } from './pallet-sold-line.entity';
import { Product } from '../products/product.entity';
import { PalletsController } from './pallets.controller';
import { PalletsService } from './pallets.service';
import { LookupsModule } from '../lookups/lookups.module';

@Module({
  imports: [TypeOrmModule.forFeature([Pallet, PalletLine, PalletSoldLine, Product]), LookupsModule],
  controllers: [PalletsController],
  providers: [PalletsService],
  // Exported so InvoicesModule can snapshot a pallet's lines onto an invoice.
  exports: [PalletsService],
})
export class PalletsModule {}
