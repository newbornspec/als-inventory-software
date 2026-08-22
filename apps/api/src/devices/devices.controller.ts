import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { DevicesService } from './devices.service';
import { IngestAuditDto } from './dto/ingest-audit.dto';
import { SetAuditLotDto } from './dto/set-audit-lot.dto';

// Hardware-audit collection. Reachable by anyone who audits — the Audit
// Station and text-mode script (perform_amazon_audit), and Goods In staff
// receiving devices (goods_in / perform_goods_in_audit). Previously these
// four endpoints carried no rule at all and were open to every logged-in user.
@Controller('devices')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DevicesController {
  constructor(private devices: DevicesService) {}

  @RequirePermissions('goods_in', 'perform_amazon_audit', 'perform_goods_in_audit')
  @Get('audit-target')
  target(@Req() req: any) {
    return this.devices.getActiveLot(req.user.userId);
  }

  @RequirePermissions('goods_in', 'perform_amazon_audit', 'perform_goods_in_audit')
  @Get('lots')
  lots() {
    return this.devices.listLots();
  }

  @RequirePermissions('goods_in', 'perform_amazon_audit', 'perform_goods_in_audit')
  @Post('active-lot')
  setLot(@Body() dto: SetAuditLotDto, @Req() req: any) {
    return this.devices.setActiveLot(req.user.userId, dto.batchId);
  }

  // The write the spec's "Perform Amazon Audit" / "Perform Goods In Audit"
  // permissions exist to gate.
  @RequirePermissions('perform_amazon_audit', 'perform_goods_in_audit')
  @Post('hardware-audit')
  ingest(@Body() dto: IngestAuditDto, @Req() req: any) {
    return this.devices.ingest(req.user.userId, dto);
  }
}
