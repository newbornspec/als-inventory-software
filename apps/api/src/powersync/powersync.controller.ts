import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AnyAuthenticated } from '../auth/guards/permissions.decorator';
import { PowerSyncService } from './powersync.service';

interface CrudEntry {
  op: 'PUT' | 'PATCH' | 'DELETE';
  table: string;
  id: string;
  data?: Record<string, unknown>;
}

@Controller('powersync')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PowerSyncController {
  constructor(private powersync: PowerSyncService) {}

  // Called by the PowerSync client SDK's uploadData() connector whenever a
  // device (online or freshly reconnected) has queued local writes to push.
  // Must write straight through to Postgres, synchronously — PowerSync's
  // checkpoint protocol assumes the data is committed by the time this returns.
  //
  // Any authenticated user: this is the offline write channel for scanning and
  // auditing, which every role does. Authorization happens INSIDE applyBatch —
  // a narrow table whitelist plus per-row ownership checks — because "may this
  // user sync" is the wrong question; "may this user write THIS row" is the one
  // that matters here.
  @AnyAuthenticated()
  @Post('upload')
  async upload(@Body() body: { batch: CrudEntry[] }, @Req() req: any) {
    await this.powersync.applyBatch(body.batch, req.user);
    return { status: 'ok' };
  }
}
