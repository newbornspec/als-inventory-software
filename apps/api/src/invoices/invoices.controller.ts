import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
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

  @Get('pallets/:id/invoices')
  listForPallet(@Param('id') id: string) {
    return this.invoices.findForPallet(id);
  }

  @Post('pallets/:id/invoices')
  create(@Param('id') id: string, @Body() dto: CreateInvoiceDto, @Req() req: any) {
    return this.invoices.createForPallet(id, dto, req.user.userId);
  }

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
