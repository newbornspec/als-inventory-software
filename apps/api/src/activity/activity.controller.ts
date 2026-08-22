import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { ActivityService } from './activity.service';

@Controller('activity')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  // Recent system-wide activity. Requires the 'activity' permission (accountability view).
  @RequirePermissions('activity')
  @Get()
  list(@Req() req: any, @Query('limit') limit?: string) {
    return this.activity.list(limit ? parseInt(limit, 10) || 100 : 100, req.user);
  }
}
