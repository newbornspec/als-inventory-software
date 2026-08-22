import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetAudit } from '../assets/asset-audit.entity';
import { AuditsController } from './audits.controller';
import { AuditsService } from './audits.service';

@Module({
  imports: [TypeOrmModule.forFeature([AssetAudit])],
  controllers: [AuditsController],
  providers: [AuditsService],
})
export class AuditsModule {}
