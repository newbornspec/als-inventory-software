import { Controller, Get, Header, Param, Query, Req, UseGuards } from '@nestjs/common';
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

  // The Reports page roll-up. from/to (ISO dates) bound the sales metrics;
  // invalid or missing dates mean "all time".
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/overview')
  getOverview(@Query('from') from: string, @Query('to') to: string, @Req() req: any) {
    const parse = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    };
    return this.reports.getOverview(parse(from), parse(to), req.user);
  }

  // Sales & finance analytics. from/to bound the summary + top-lists; the
  // monthly trend is a fixed rolling 12 months.
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/sales')
  getSales(@Query('from') from: string, @Query('to') to: string, @Req() req: any) {
    const parse = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    };
    return this.reports.getSalesAnalytics(parse(from), parse(to), req.user);
  }

  // Batch → sub-lot performance for the drill-down. from/to bound revenue/profit.
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/batches')
  getBatchAnalytics(@Query('from') from: string, @Query('to') to: string, @Req() req: any) {
    const parse = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    };
    return this.reports.getBatchAnalytics(parse(from), parse(to), req.user);
  }

  // Warehouse operations throughput (received/audited/shipped/sold/returned,
  // avg processing time, daily pulse). from/to bound the window.
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/warehouse')
  getWarehouse(@Query('from') from: string, @Query('to') to: string, @Req() req: any) {
    const parse = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    };
    return this.reports.getWarehouseThroughput(parse(from), parse(to), req.user);
  }

  // Per-user performance for the manager comparison. from/to bound the counts.
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/users')
  getUserPerformance(@Query('from') from: string, @Query('to') to: string, @Req() req: any) {
    const parse = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    };
    return this.reports.getUserPerformance(parse(from), parse(to), req.user);
  }

  // Consumables (bulk stock) analytics. Global — consumables aren't lot-scoped.
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @Get('reports/consumables')
  getConsumables(@Query('from') from: string, @Query('to') to: string) {
    const parse = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return isNaN(d.getTime()) ? undefined : d;
    };
    return this.reports.getConsumablesReport(parse(from), parse(to));
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
