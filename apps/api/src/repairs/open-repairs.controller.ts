import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { RepairsService } from './repairs.service';

// A warehouse-wide view of unfinished repair work. The per-asset controller
// (assets/:assetId/repairs) answers "what happened to this device"; this one
// answers "what is outstanding", which is the question the dashboard's Open
// repairs row leads with. Any authenticated role, same as logging a repair.
@Controller('repairs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OpenRepairsController {
  constructor(private repairs: RepairsService) {}

  @Get()
  findOpen(@Req() req: any) {
    return this.repairs.findOpen(req.user);
  }
}
