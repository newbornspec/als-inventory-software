import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DevicesService } from './devices.service';
import { IngestAuditDto } from './dto/ingest-audit.dto';
import { SetAuditLotDto } from './dto/set-audit-lot.dto';

// Hardware-audit collection. Any authenticated role — technicians run audits and
// set the lot they're working on.
@Controller('devices')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DevicesController {
  constructor(private devices: DevicesService) {}

  @Get('audit-target')
  target(@Req() req: any) {
    return this.devices.getActiveLot(req.user.userId);
  }

  @Get('lots')
  lots() {
    return this.devices.listLots();
  }

  @Post('active-lot')
  setLot(@Body() dto: SetAuditLotDto, @Req() req: any) {
    return this.devices.setActiveLot(req.user.userId, dto.batchId);
  }

  @Post('hardware-audit')
  ingest(@Body() dto: IngestAuditDto, @Req() req: any) {
    return this.devices.ingest(req.user.userId, dto);
  }
}
