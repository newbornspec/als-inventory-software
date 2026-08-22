import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/guards/permissions.decorator';
import { DashboardService } from './dashboard.service';

// Every default permission set includes 'dashboard' — the operational
// dashboard is what a technician opens at the start of a shift. The money in
// it is gated inside the service instead: `finance` comes back null for anyone
// who may not see cost or revenue, so granting the module never grants figures.
@Controller('dashboard')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DashboardController {
  constructor(private dashboard: DashboardService) {}

  @RequirePermissions('dashboard')
  @Get('operations')
  getOperations(@Req() req: any) {
    return this.dashboard.getOperations(req.user);
  }
}
