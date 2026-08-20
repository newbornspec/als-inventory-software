import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '../assets/asset.entity';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

// Only Asset is registered: the service aggregates in SQL across several tables
// rather than loading each one into Node, so it needs one repository to borrow a
// connection from, not one per table. Loading whole tables to count them in
// JavaScript is what the reports service does, and it does not scale past a few
// thousand rows.
@Module({
  imports: [TypeOrmModule.forFeature([Asset])],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
