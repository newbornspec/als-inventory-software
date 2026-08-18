import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Invoice } from './invoice.entity';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PalletsModule } from '../pallets/pallets.module';

// Reads a pallet's lines to snapshot them onto the invoice, so it depends on
// PalletsModule rather than reaching into the pallet repositories directly.
@Module({
  imports: [TypeOrmModule.forFeature([Invoice]), PalletsModule],
  controllers: [InvoicesController],
  providers: [InvoicesService],
})
export class InvoicesModule {}
