import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { BatchesService } from './batches.service';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { ReassignOwnerDto } from './dto/reassign-owner.dto';
import { CertificatesService } from '../assets/certificates.service';

@Controller('batches')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BatchesController {
  constructor(
    private batches: BatchesService,
    private certificates: CertificatesService,
  ) {}

  // Viewing needs goods_in or assets — technicians select an open batch to
  // receive against on the scan page. Managers are scoped to their own lots;
  // admins/technicians see all (see common/ownership.ts).
  @RequirePermissions('goods_in', 'assets')
  @Get()
  findAll(@Req() req: any) {
    return this.batches.findAll(req.user);
  }

  @RequirePermissions('goods_in', 'assets')
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.batches.findOne(id, req.user);
  }

  // Requires the export permission.
  // generateReport still applies per-user scoping via req.user.
  @RequirePermissions('export')
  @Get(':id/report.xlsx')
  async report(@Param('id') id: string, @Req() req: any): Promise<StreamableFile> {
    const { buffer, filename } = await this.batches.generateReport(id, req.user);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  // Bulk Certificate of Data Erasure for every wiped device in the lot (PDF).
  @RequirePermissions('goods_in', 'assets')
  @Get(':id/erasure-certificate.pdf')
  async erasureCertificate(@Param('id') id: string, @Req() req: any): Promise<StreamableFile> {
    const { buffer, filename } = await this.certificates.lotErasureCertificate(id, req.user);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  // Creating requires create_batch; editing requires edit_batch.
  @RequirePermissions('create_batch')
  @Post()
  create(@Body() dto: CreateBatchDto, @Req() req: any) {
    return this.batches.create(dto, req.user);
  }

  @RequirePermissions('edit_batch')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateBatchDto, @Req() req: any) {
    return this.batches.update(id, dto, req.user);
  }

  // Sell the whole lot: marks every remaining device Sold and the lot 'sold'.
  // Requires the sell_items permission (the lock is what's restricted).
  @RequirePermissions('sell_items')
  @Post(':id/sell')
  sellBatch(@Param('id') id: string, @Body() body: { saleTotal?: number }, @Req() req: any) {
    return this.batches.sellBatch(id, req.user, body?.saleTotal);
  }

  // Reassign a lot to another owner — requires manage_ownership.
  @RequirePermissions('manage_ownership')
  @Patch(':id/owner')
  reassignOwner(@Param('id') id: string, @Body() dto: ReassignOwnerDto, @Req() req: any) {
    return this.batches.reassignOwner(id, dto.ownerId, req.user);
  }

  @RequirePermissions('delete_batch')
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.batches.remove(id, req.user.userId);
  }
}
