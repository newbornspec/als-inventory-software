import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { AuditsService } from './audits.service';

// The Audit workspace's read side: a chronological, day-grouped feed across
// ALL devices — deliberately not reachable through a lot, matching how the
// data hangs together (audits belong to the device, not the lot it happened
// to arrive in). Gated on the amazon_audit module, which every default
// permission set includes.
@Controller('audits')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AuditsController {
  constructor(private audits: AuditsService) {}

  @RequirePermissions('amazon_audit')
  @Get('days')
  days(@Req() req: any, @Query('limit') limit?: string) {
    return this.audits.days(req.user, limit ? parseInt(limit, 10) || 30 : 30);
  }

  @RequirePermissions('amazon_audit')
  @Get('days/:day')
  day(@Param('day') day: string, @Req() req: any) {
    return this.audits.day(day, req.user);
  }
}
