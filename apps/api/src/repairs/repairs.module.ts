import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RepairLog } from './repair-log.entity';
import { Asset } from '../assets/asset.entity';
import { RepairsController } from './repairs.controller';
import { RepairsService } from './repairs.service';

@Module({
  imports: [TypeOrmModule.forFeature([RepairLog, Asset])],
  controllers: [RepairsController],
  providers: [RepairsService],
})
export class RepairsModule {}
