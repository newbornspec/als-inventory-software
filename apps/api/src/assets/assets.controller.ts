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
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { AssetsService } from './assets.service';
import { BarcodeService, BarcodeType } from './barcode.service';
import { CertificatesService } from './certificates.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import { CreateAssetAuditDto } from './dto/create-asset-audit.dto';

@Controller('assets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AssetsController {
  constructor(
    private assets: AssetsService,
    private barcodeService: BarcodeService,
    private certificates: CertificatesService,
  ) {}

  // Any authenticated role can view/search — technicians need this to look
  // up assets in the field, not just admins/managers.
  @Get()
  findAll(@Query() query: QueryAssetsDto, @Req() req: any) {
    return this.assets.findAll(query, req.user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.assets.findOne(id, req.user);
  }

  @Get(':id/history')
  findHistory(@Param('id') id: string, @Req() req: any) {
    return this.assets.findHistory(id, req.user);
  }

  @Get(':id/audits')
  findAudits(@Param('id') id: string, @Req() req: any) {
    return this.assets.findAudits(id, req.user);
  }

  // Open to any role, unlike create/update/delete — recording a physical
  // ITAD audit (grading, testing, data wipe) is field work a technician
  // does, not an admin/manager-only action.
  @Post(':id/audits')
  createAudit(
    @Param('id') id: string,
    @Body() dto: CreateAssetAuditDto,
    @Req() req: any,
  ) {
    return this.assets.createAudit(id, dto, req.user.userId);
  }

  // Certificate of Data Erasure (PDF). Any authed role — a technician who wiped
  // the unit may need to produce the certificate for the customer.
  @Get(':id/erasure-certificate.pdf')
  @Header('Cache-Control', 'no-store')
  async erasureCertificate(@Param('id') id: string, @Req() req: any): Promise<StreamableFile> {
    const { buffer, filename } = await this.certificates.erasureCertificate(id, req.user);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get(':id/barcode')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'no-store')
  async barcode(
    @Param('id') id: string,
    @Query('type') type?: string,
  ): Promise<StreamableFile> {
    const asset = await this.assets.findOne(id);
    const normalizedType: BarcodeType = type === 'code128' ? 'code128' : 'qr';
    const buffer = await this.barcodeService.generate(asset.tag, normalizedType);
    return new StreamableFile(buffer);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN)
  @Post()
  create(@Body() dto: CreateAssetDto, @Req() req: any) {
    return this.assets.create(dto, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.TECHNICIAN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAssetDto, @Req() req: any) {
    return this.assets.update(id, dto, req.user);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.assets.remove(id, req.user.userId);
  }
}
