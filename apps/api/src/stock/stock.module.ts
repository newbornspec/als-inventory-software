import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Location } from '../locations/location.entity';
import { StockLine } from './stock-line.entity';
import { StockMovement } from './stock-movement.entity';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

@Module({
  imports: [TypeOrmModule.forFeature([StockLine, StockMovement, Location])],
  controllers: [StockController],
  providers: [StockService],
})
export class StockModule {}
