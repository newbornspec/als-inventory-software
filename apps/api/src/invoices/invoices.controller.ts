import {
  Controller,
  Get,
  Header,
  Param,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { InvoicesService } from './invoices.service';
import { renderInvoice } from './invoice-pdf';
import { safeFilePart } from '../pallets/pallets.service';

// Invoicing is a money document: admin and manager only, matching the pallet
// report and costing sheet rather than the wider line-editing roles.
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
export class InvoicesController {
  constructor(private invoices: InvoicesService) {}

  // The number the next invoice would get. Does not consume it — see
  // peekNextNumber for why an abandoned form must not leave a gap.
  @Get('invoices/next-number')
  nextNumber() {
    return this.invoices.peekNextNumber();
  }

  // The pallets/:id/invoices routes were removed. Invoicing is being rebuilt as
  // one general system rather than a document raised from a pallet, so nothing
  // can now create or list an invoice against a pallet. The read routes below
  // stay: invoices already raised remain fetchable and printable, and the
  // service keeps its numbering and snapshot logic for the replacement to use.

  @Get('invoices/:id')
  findOne(@Param('id') id: string) {
    return this.invoices.findOne(id);
  }

  @Get('invoices/:id/invoice.pdf')
  @Header('Cache-Control', 'no-store')
  async pdf(@Param('id') id: string): Promise<StreamableFile> {
    const invoice = await this.invoices.findOne(id);
    const buffer = await renderInvoice(invoice);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${safeFilePart(invoice.invoiceNumber, invoice.id)}.pdf"`,
    });
  }
}
