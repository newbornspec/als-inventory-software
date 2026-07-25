import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '../assets/asset.entity';
import { Batch } from '../batches/batch.entity';
import { Lot } from '../batches/lot.entity';
import { OrderLine } from '../sales/order-line.entity';
import { RepairLog } from '../repairs/repair-log.entity';
import { StockLine } from '../stock/stock-line.entity';
import { Pallet } from '../pallets/pallet.entity';
import { PalletLine } from '../pallets/pallet-line.entity';
import { PalletSoldLine } from '../pallets/pallet-sold-line.entity';
import { User } from '../users/user.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Asset,
      Batch,
      Lot,
      OrderLine,
      RepairLog,
      StockLine,
      Pallet,
      PalletLine,
      PalletSoldLine,
      User,
    ]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
