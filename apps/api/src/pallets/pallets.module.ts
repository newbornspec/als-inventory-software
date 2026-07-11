import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Pallet } from './pallet.entity';
import { PalletLine } from './pallet-line.entity';
import { PalletsController } from './pallets.controller';
import { PalletsService } from './pallets.service';

@Module({
  imports: [TypeOrmModule.forFeature([Pallet, PalletLine])],
  controllers: [PalletsController],
  providers: [PalletsService],
})
export class PalletsModule {}
