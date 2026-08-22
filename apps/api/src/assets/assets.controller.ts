import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { AssetsService } from './assets.service';
import { BarcodeService, BarcodeType } from './barcode.service';
import { CertificatesService } from './certificates.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import { CreateAssetAuditDto } from './dto/create-asset-audit.dto';

@Controller('assets')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AssetsController {
  constructor(
    private assets: AssetsService,
    private barcodeService: BarcodeService,
    private certificates: CertificatesService,
  ) {}

  // Viewable with assets, goods_in, or scan permission — technicians need this
  // to look up assets in the field, not just admins/managers.
  @RequirePermissions('assets', 'goods_in', 'scan')
  @Get()
  findAll(@Query() query: QueryAssetsDto, @Req() req: any) {
    return this.assets.findAll(query, req.user);
  }

  // Declared before ':id' so 'sold' isn't captured as an asset id. The Sold
  // archive of serialized devices.
  @RequirePermissions('sold')
  @Get('sold')
  findSold() {
    return this.assets.findSold();
  }

  // Bulk return from the Sold page — requires return_sold, like single returns.
  // No batchId -> each asset returns to its own original lot.
  @RequirePermissions('return_sold')
  @Post('sold/return-bulk')
  bulkReturn(@Body() body: { assetIds: string[]; batchId?: string }, @Req() req: any) {
    return this.assets.bulkReturnFromSold(body?.assetIds ?? [], body?.batchId, req.user);
  }

  @RequirePermissions('assets', 'goods_in', 'scan')
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.assets.findOne(id, req.user);
  }

  @RequirePermissions('assets', 'goods_in', 'scan')
  @Get(':id/history')
  findHistory(@Param('id') id: string, @Req() req: any) {
    return this.assets.findHistory(id, req.user);
  }

  @RequirePermissions('assets', 'goods_in', 'scan', 'amazon_audit')
  @Get(':id/audits')
  findAudits(@Param('id') id: string, @Req() req: any) {
    return this.assets.findAudits(id, req.user);
  }

  // Requires a perform-audit permission — recording a physical
  // ITAD audit (grading, testing, data wipe) is field work a technician
  // does, not an admin/manager-only action.
  @RequirePermissions('perform_goods_in_audit', 'perform_amazon_audit')
  @Post(':id/audits')
  createAudit(
    @Param('id') id: string,
    @Body() dto: CreateAssetAuditDto,
    @Req() req: any,
  ) {
    return this.assets.createAudit(id, dto, req.user.userId);
  }

  // Certificate of Data Erasure (PDF). Requires assets, goods_in, or
  // amazon_audit — a technician who wiped the unit may need to produce the
  // certificate for the customer.
  @RequirePermissions('assets', 'goods_in', 'amazon_audit')
  @Get(':id/erasure-certificate.pdf')
  @Header('Cache-Control', 'no-store')
  async erasureCertificate(@Param('id') id: string, @Req() req: any): Promise<StreamableFile> {
    const { buffer, filename } = await this.certificates.erasureCertificate(id, req.user);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @RequirePermissions('assets', 'goods_in', 'scan')
  @Get(':id/barcode')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'no-store')
  async barcode(
    @Param('id') id: string,
    @Query('type') type?: string,
    @Query('text') text?: string,
  ): Promise<StreamableFile> {
    const asset = await this.assets.findOne(id);
    const normalizedType: BarcodeType = type === 'code128' ? 'code128' : 'qr';
    // Encode the permanent Unit ID. Falls back to the tag for any asset that
    // predates the Unit ID column, so old printed labels and this endpoint
    // never disagree. Search resolves either value, so scanning works for both.
    // text=0 -> bars only (the label prints the Unit ID itself, larger).
    const buffer = await this.barcodeService.generate(
      asset.unitId ?? asset.tag,
      normalizedType,
      text !== '0',
    );
    return new StreamableFile(buffer);
  }

  @RequirePermissions('assets', 'goods_in')
  @Post()
  create(@Body() dto: CreateAssetDto, @Req() req: any) {
    return this.assets.create(dto, req.user);
  }

  @RequirePermissions('assets', 'goods_in')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAssetDto, @Req() req: any) {
    return this.assets.update(id, dto, req.user);
  }

  // Selling is normal warehouse work — requires sell_items. Locking is what's restricted.
  // salePrice is optional; when given it feeds the revenue/profit reports.
  @RequirePermissions('sell_items')
  @Post(':id/sell')
  sell(@Param('id') id: string, @Body() body: { salePrice?: number }, @Req() req: any) {
    return this.assets.sell(id, req.user, body?.salePrice);
  }

  // Returning a sold item to inventory requires return_sold, per the Sold workflow.
  @RequirePermissions('return_sold')
  @Post(':id/return')
  returnFromSold(
    @Param('id') id: string,
    @Body() body: { batchId?: string | null },
    @Req() req: any,
  ) {
    return this.assets.returnFromSold(id, body?.batchId, req.user);
  }

  @RequirePermissions('delete_asset')
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.assets.remove(id, req.user.userId);
  }
}
