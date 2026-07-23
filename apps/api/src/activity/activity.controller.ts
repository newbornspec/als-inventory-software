import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { ActivityService } from './activity.service';

@Controller('activity')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  // Recent system-wide activity. Admin + manager (accountability view).
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get()
  list(@Query('limit') limit?: string) {
    return this.activity.list(limit ? parseInt(limit, 10) || 100 : 100);
  }
}
