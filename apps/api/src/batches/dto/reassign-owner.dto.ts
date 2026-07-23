import { IsUUID } from 'class-validator';

// Admin action: hand a purchase lot to a different owner.
export class ReassignOwnerDto {
  @IsUUID()
  ownerId: string;
}
