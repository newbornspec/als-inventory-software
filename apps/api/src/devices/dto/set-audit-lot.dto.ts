import { IsUUID } from 'class-validator';

export class SetAuditLotDto {
  @IsUUID() batchId: string;
}
