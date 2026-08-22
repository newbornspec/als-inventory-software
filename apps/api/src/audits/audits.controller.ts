import { BadRequestException, Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { AUDIT_KIND_FILTERS, AuditKindFilter, AuditsService } from './audits.service';

function parseKind(kind?: string): AuditKindFilter | undefined {
  if (!kind) return undefined;
  if ((AUDIT_KIND_FILTERS as readonly string[]).includes(kind)) return kind as AuditKindFilter;
  throw new BadRequestException(`kind must be one of: ${AUDIT_KIND_FILTERS.join(', ')}`);
}

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
  days(@Req() req: any, @Query('limit') limit?: string, @Query('kind') kind?: string) {
    return this.audits.days(req.user, limit ? parseInt(limit, 10) || 30 : 30, parseKind(kind));
  }

  @RequirePermissions('amazon_audit')
  @Get('days/:day')
  day(@Param('day') day: string, @Req() req: any, @Query('kind') kind?: string) {
    return this.audits.day(day, req.user, parseKind(kind));
  }
}
