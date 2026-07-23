import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PowerSyncService } from './powersync.service';

interface CrudEntry {
  op: 'PUT' | 'PATCH' | 'DELETE';
  table: string;
  id: string;
  data?: Record<string, unknown>;
}

@Controller('powersync')
@UseGuards(JwtAuthGuard)
export class PowerSyncController {
  constructor(private powersync: PowerSyncService) {}

  // Called by the PowerSync client SDK's uploadData() connector whenever a
  // device (online or freshly reconnected) has queued local writes to push.
  // Must write straight through to Postgres, synchronously — PowerSync's
  // checkpoint protocol assumes the data is committed by the time this returns.
  @Post('upload')
  async upload(@Body() body: { batch: CrudEntry[] }, @Req() req: any) {
    await this.powersync.applyBatch(body.batch, req.user);
    return { status: 'ok' };
  }
}
