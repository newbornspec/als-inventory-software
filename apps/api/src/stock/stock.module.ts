import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockLine } from './stock-line.entity';
import { StockMovement } from './stock-movement.entity';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

@Module({
  imports: [TypeOrmModule.forFeature([StockLine, StockMovement])],
  controllers: [StockController],
  providers: [StockService],
})
export class StockModule {}
