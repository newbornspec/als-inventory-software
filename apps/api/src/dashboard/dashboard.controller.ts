import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DashboardService } from './dashboard.service';

// Deliberately NOT @Roles(ADMIN, MANAGER). The operational dashboard is what a
// technician opens at the start of a shift — what needs attention, what is
// arriving, where things are. The money in it is gated inside the service
// instead: `finance` comes back null for anyone who may not see cost or
// revenue, so widening access here never widens access to figures.
@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private dashboard: DashboardService) {}

  @Get('operations')
  getOperations(@Req() req: any) {
    return this.dashboard.getOperations(req.user);
  }
}
