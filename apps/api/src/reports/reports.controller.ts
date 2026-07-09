import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { ReportsService } from './reports.service';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportsController {
  constructor(private reports: ReportsService) {}

  // Any authenticated role sees alerts — a technician in the field benefits
  // from knowing an asset they're about to touch is flagged just as much
  // as an admin does.
  @Get('notifications')
  getNotifications() {
    return this.reports.getNotifications();
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/assets.csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="assets.csv"')
  async exportAssetsCsv() {
    return this.reports.exportAssetsCsv();
  }
}
