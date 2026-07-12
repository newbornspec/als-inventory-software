import { IsString } from 'class-validator';
import { CreateAssetAuditDto } from './create-asset-audit.dto';

// What the bootable capture tool posts: the asset's tag/serial (to find the
// device) plus all the auto-read spec fields (inherited from the audit DTO).
export class HardwareAuditDto extends CreateAssetAuditDto {
  @IsString() tag: string;
}
