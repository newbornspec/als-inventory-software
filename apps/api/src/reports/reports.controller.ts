import { Controller, Get, Header, Param, Req, UseGuards } from '@nestjs/common';
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
  getNotifications(@Req() req: any) {
    return this.reports.getNotifications(req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/assets.csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="assets.csv"')
  async exportAssetsCsv(@Req() req: any) {
    return this.reports.exportAssetsCsv(req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/dashboard')
  getDashboard(@Req() req: any) {
    return this.reports.getDashboard(req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/profit')
  getLotProfitability(@Req() req: any) {
    return this.reports.getLotProfitability(req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/assets/:id/costing')
  getAssetCosting(@Param('id') id: string, @Req() req: any) {
    return this.reports.getAssetCosting(id, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/profit.csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="lot-profit.csv"')
  async exportProfitCsv(@Req() req: any) {
    return this.reports.exportProfitCsv(req.user);
  }
}
